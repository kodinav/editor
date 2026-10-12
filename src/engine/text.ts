import type { TextStyle } from '@/core/types';
import { cssFontFamily, ensureFont, isFontReady, resolveWeight } from './fonts';

/**
 * Text layout + rasterization with Canvas 2D. Output canvases are cached by
 * content so static titles cost nothing per frame. The intrinsic size of a
 * text layer (in project pixels) is canvas size / render scale.
 */

export interface TextRender {
  canvas: OffscreenCanvas;
  /** Size in project pixels. */
  w: number;
  h: number;
  /** Whether all fonts were available (false = fallback glyphs were used). */
  complete: boolean;
}

interface Line {
  text: string;
  width: number;
  /** Index of the first character of this line within the (transformed) full text. */
  start: number;
  /** The paragraph reads right to left (Arabic, Hebrew…). */
  rtl: boolean;
}

const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
const LETTER = /\p{L}/u;
/** Scripts whose letters join or reorder: these must be drawn as whole runs, never glyph by glyph. */
const SHAPED = /[\u0590-\u08FF\u0900-\u0DFF\u0E00-\u0EFF\u1000-\u109F\u1780-\u17FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;

/** Base direction of a paragraph: that of its first letter (the Unicode "first strong character" rule). */
export function isRtl(text: string): boolean {
  for (const ch of text) {
    if (RTL_CHAR.test(ch)) return true;
    if (LETTER.test(ch)) return false;
  }
  return false;
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** User-perceived characters: an emoji, or a letter with its accents, stays in one piece. */
export function graphemes(s: string): string[] {
  if (!segmenter) return [...s];
  const out: string[] = [];
  for (const g of segmenter.segment(s)) out.push(g.segment);
  return out;
}

/** The first `n` UTF-16 units of `s`, shortened so it never ends inside a character. */
function prefix(s: string, n: number): string {
  if (n >= s.length) return s;
  let out = '';
  for (const g of graphemes(s)) {
    if (out.length + g.length > n) break;
    out += g;
  }
  return out;
}

let measureCtx: OffscreenCanvasRenderingContext2D | null = null;
function mctx(): OffscreenCanvasRenderingContext2D {
  if (!measureCtx) measureCtx = new OffscreenCanvas(8, 8).getContext('2d')!;
  return measureCtx;
}

function fontString(style: TextStyle, size: number): string {
  const r = resolveWeight(style.fontFamily, style.fontWeight, style.italic);
  return `${style.italic ? 'italic ' : ''}${r.weight} ${size}px ${cssFontFamily(style.fontFamily)}`;
}

const supportsLetterSpacing = typeof OffscreenCanvasRenderingContext2D !== 'undefined' && 'letterSpacing' in OffscreenCanvasRenderingContext2D.prototype;

function measure(ctx: OffscreenCanvasRenderingContext2D, s: string, spacingPx: number): number {
  if (!s) return 0;
  if (supportsLetterSpacing || spacingPx === 0 || SHAPED.test(s)) return ctx.measureText(s).width;
  return ctx.measureText(s).width + spacingPx * Math.max(0, graphemes(s).length - 1);
}

function wrap(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number, spacingPx: number): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const para of text.split('\n')) {
    const rtl = isRtl(para);
    if (para === '') {
      lines.push({ text: '', width: 0, start: offset, rtl });
      offset += 1;
      continue;
    }
    const tokens = para.split(/(\s+)/);
    let cur = '';
    let curStart = offset;
    let pos = offset;
    for (const tok of tokens) {
      const candidate = cur + tok;
      if (cur && measure(ctx, candidate.trimEnd(), spacingPx) > maxWidth && tok.trim()) {
        lines.push({ text: cur.trimEnd(), width: measure(ctx, cur.trimEnd(), spacingPx), start: curStart, rtl });
        cur = tok;
        curStart = pos;
      } else {
        cur = candidate;
      }
      // Hard-break single words that are wider than the box.
      while (measure(ctx, cur, spacingPx) > maxWidth && !/\s/.test(cur) && graphemes(cur).length > 1) {
        const chars = graphemes(cur);
        let n = chars.length - 1;
        while (n > 1 && measure(ctx, chars.slice(0, n).join(''), spacingPx) > maxWidth) n--;
        const head = chars.slice(0, n).join('');
        lines.push({ text: head, width: measure(ctx, head, spacingPx), start: curStart, rtl });
        curStart += head.length;
        cur = chars.slice(n).join('');
      }
      pos += tok.length;
    }
    lines.push({ text: cur.trimEnd(), width: measure(ctx, cur.trimEnd(), spacingPx), start: curStart, rtl });
    offset += para.length + 1;
  }
  return lines;
}

function roundRect(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, newPath = true) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (newPath) ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function hexAlpha(hex: string, a: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export interface TextRenderOptions {
  /** Render pixels per project pixel. */
  scale: number;
  frameWidth: number;
  /** Number of characters to draw (typewriter), null = all. */
  visibleChars?: number | null;
  /** Character range to draw in highlight color (karaoke captions). */
  highlight?: { start: number; end: number; color: string } | null;
}

function drawSpaced(ctx: OffscreenCanvasRenderingContext2D, s: string, x: number, y: number, spacingPx: number, mode: 'fill' | 'stroke') {
  if (supportsLetterSpacing || spacingPx === 0 || SHAPED.test(s)) {
    if (mode === 'fill') ctx.fillText(s, x, y);
    else ctx.strokeText(s, x, y);
    return;
  }
  let cx = x;
  for (const ch of graphemes(s)) {
    if (mode === 'fill') ctx.fillText(ch, cx, y);
    else ctx.strokeText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacingPx;
  }
}

export function renderText(rawText: string, style: TextStyle, opts: TextRenderOptions): TextRender {
  const text = style.uppercase ? rawText.toUpperCase() : rawText;
  void ensureFont(style.fontFamily, style.fontWeight, style.italic, text);
  const complete = isFontReady(style.fontFamily, style.fontWeight, style.italic, text);
  const s = Math.max(0.05, opts.scale);
  const size = style.fontSize * s;
  const spacing = style.letterSpacing * size;
  const ctx = mctx();
  ctx.font = fontString(style, size);
  if (supportsLetterSpacing) (ctx as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`;
  const maxW = Math.max(size, style.maxWidth * opts.frameWidth * s);
  const lines = wrap(ctx, text || ' ', maxW, spacing);
  const lineH = size * style.lineHeight;
  const metrics = ctx.measureText('Hg');
  const ascent = metrics.fontBoundingBoxAscent ?? size * 0.8;
  const descent = metrics.fontBoundingBoxDescent ?? size * 0.2;
  const contentW = Math.max(1, ...lines.map((l) => l.width));
  const contentH = lineH * (lines.length - 1) + ascent + descent;

  const hasBg = !!style.backgroundColor && style.backgroundOpacity > 0;
  const padX = hasBg ? style.backgroundPadding * size : 0;
  const padY = hasBg ? style.backgroundPadding * size * 0.55 : 0;
  const stroke = style.strokeWidth * s;
  const shadowExtent = style.shadowBlur > 0 ? (style.shadowBlur * 1.5 + Math.max(Math.abs(style.shadowX), Math.abs(style.shadowY))) * s : 0;
  const margin = Math.ceil(stroke + shadowExtent + 2);

  const W = Math.min(8192, Math.ceil(contentW + padX * 2 + margin * 2));
  const H = Math.min(8192, Math.ceil(contentH + padY * 2 + margin * 2));
  const canvas = new OffscreenCanvas(W, H);
  const c = canvas.getContext('2d')!;
  c.font = ctx.font;
  if (supportsLetterSpacing) (c as unknown as { letterSpacing: string }).letterSpacing = `${spacing}px`;
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  c.lineJoin = 'round';
  c.miterLimit = 2;

  const originX = margin + padX;
  const originY = margin + padY;
  const lineX = (l: Line) =>
    style.align === 'left' ? originX : style.align === 'right' ? originX + contentW - l.width : originX + (contentW - l.width) / 2;

  // Background boxes, one per line, filled as a single shape: where they overlap, a
  // translucent colour is applied once (no darker bands between lines).
  if (hasBg) {
    c.fillStyle = hexAlpha(style.backgroundColor!, style.backgroundOpacity);
    const radius = style.backgroundRadius * size;
    c.beginPath();
    lines.forEach((l, i) => {
      if (!l.text.trim()) return;
      const x = lineX(l) - padX;
      const top = originY - padY + i * lineH;
      const h = (i === lines.length - 1 ? ascent + descent : lineH) + padY * 2;
      roundRect(c, x, top, l.width + padX * 2, h + (i < lines.length - 1 ? 1 : 0), radius, false);
    });
    c.fill('nonzero');
  }

  const visible = opts.visibleChars ?? Infinity;
  const drawPass = (mode: 'stroke' | 'fill', color: string) => {
    lines.forEach((l, i) => {
      const remaining = visible - l.start;
      if (remaining <= 0) return;
      const str = prefix(l.text, remaining);
      if (!str) return;
      const y = originY + ascent + i * lineH;
      // Positions are always the run's left edge; `direction` only sets how mixed text is ordered.
      // A partly revealed right-to-left line grows leftwards from the line's right edge.
      c.direction = l.rtl ? 'rtl' : 'ltr';
      const x = l.rtl && str !== l.text ? lineX(l) + l.width - measure(c, str, spacing) : lineX(l);
      if (mode === 'stroke') {
        c.strokeStyle = color;
        c.lineWidth = stroke * 2;
        drawSpaced(c, str, x, y, spacing, 'stroke');
      } else {
        c.fillStyle = color;
        drawSpaced(c, str, x, y, spacing, 'fill');
        const hl = opts.highlight;
        if (hl) {
          const a = Math.max(hl.start, l.start) - l.start;
          const b = Math.min(hl.end, l.start + str.length) - l.start;
          if (b > a) {
            // Recolour the highlighted words by redrawing the line through a clip: letter shapes,
            // joining and kerning stay exactly as drawn, in either direction.
            const before = measure(c, l.text.slice(0, a), spacing);
            const through = measure(c, l.text.slice(0, b), spacing);
            const left = lineX(l);
            const edge = (at: number) => (at <= 0 || at >= l.text.length || /\s/.test(l.text[at - 1]) || /\s/.test(l.text[at]) ? size * 0.08 : 0);
            const x0 = (l.rtl ? left + l.width - through : left + before) - (l.rtl ? edge(b) : edge(a));
            const x1 = (l.rtl ? left + l.width - before : left + through) + (l.rtl ? edge(a) : edge(b));
            c.save();
            c.beginPath();
            c.rect(x0, y - ascent - lineH, x1 - x0, ascent + descent + lineH * 2);
            c.clip();
            c.fillStyle = hl.color;
            drawSpaced(c, str, x, y, spacing, 'fill');
            c.restore();
          }
        }
      }
    });
  };

  if (style.shadowBlur > 0 || style.shadowX !== 0 || style.shadowY !== 0) {
    if (style.shadowBlur > 0) {
      c.save();
      c.shadowColor = style.shadowColor;
      c.shadowBlur = style.shadowBlur * s;
      c.shadowOffsetX = style.shadowX * s;
      c.shadowOffsetY = style.shadowY * s;
      if (stroke > 0) drawPass('stroke', style.strokeColor);
      else drawPass('fill', style.color);
      c.restore();
    }
  }
  if (stroke > 0) drawPass('stroke', style.strokeColor);
  drawPass('fill', style.color);

  return { canvas, w: W / s, h: H / s, complete };
}

/** Cheap measurement in project pixels (for UI gizmos when no render exists yet). */
export function measureText(rawText: string, style: TextStyle, frameWidth: number): { w: number; h: number } {
  const r = renderText(rawText, style, { scale: 0.25, frameWidth });
  return { w: r.w, h: r.h };
}
