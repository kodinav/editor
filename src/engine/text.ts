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
  if (supportsLetterSpacing || spacingPx === 0) return ctx.measureText(s).width;
  return ctx.measureText(s).width + spacingPx * Math.max(0, [...s].length - 1);
}

function wrap(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number, spacingPx: number): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const para of text.split('\n')) {
    if (para === '') {
      lines.push({ text: '', width: 0, start: offset });
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
        lines.push({ text: cur.trimEnd(), width: measure(ctx, cur.trimEnd(), spacingPx), start: curStart });
        cur = tok;
        curStart = pos;
      } else {
        cur = candidate;
      }
      // Hard-break single words that are wider than the box.
      while (measure(ctx, cur, spacingPx) > maxWidth && [...cur].length > 1 && !/\s/.test(cur)) {
        const chars = [...cur];
        let n = chars.length - 1;
        while (n > 1 && measure(ctx, chars.slice(0, n).join(''), spacingPx) > maxWidth) n--;
        const head = chars.slice(0, n).join('');
        lines.push({ text: head, width: measure(ctx, head, spacingPx), start: curStart });
        curStart += head.length;
        cur = chars.slice(n).join('');
      }
      pos += tok.length;
    }
    lines.push({ text: cur.trimEnd(), width: measure(ctx, cur.trimEnd(), spacingPx), start: curStart });
    offset += para.length + 1;
  }
  return lines;
}

function roundRect(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
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
  if (supportsLetterSpacing || spacingPx === 0) {
    if (mode === 'fill') ctx.fillText(s, x, y);
    else ctx.strokeText(s, x, y);
    return;
  }
  let cx = x;
  for (const ch of s) {
    if (mode === 'fill') ctx.fillText(ch, cx, y);
    else ctx.strokeText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacingPx;
  }
}

export function renderText(rawText: string, style: TextStyle, opts: TextRenderOptions): TextRender {
  void ensureFont(style.fontFamily, style.fontWeight, style.italic);
  const complete = isFontReady(style.fontFamily, style.fontWeight, style.italic);
  const s = Math.max(0.05, opts.scale);
  const text = style.uppercase ? rawText.toUpperCase() : rawText;
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
  c.lineJoin = 'round';
  c.miterLimit = 2;

  const originX = margin + padX;
  const originY = margin + padY;
  const lineX = (l: Line) =>
    style.align === 'left' ? originX : style.align === 'right' ? originX + contentW - l.width : originX + (contentW - l.width) / 2;

  // Background boxes, one per line, merged visually by overlapping slightly.
  if (hasBg) {
    c.fillStyle = hexAlpha(style.backgroundColor!, style.backgroundOpacity);
    const radius = style.backgroundRadius * size;
    lines.forEach((l, i) => {
      if (!l.text.trim()) return;
      const x = lineX(l) - padX;
      const top = originY - padY + i * lineH;
      const h = (i === lines.length - 1 ? ascent + descent : lineH) + padY * 2;
      roundRect(c, x, top, l.width + padX * 2, h + (i < lines.length - 1 ? 1 : 0), radius);
      c.fill();
    });
  }

  const visible = opts.visibleChars ?? Infinity;
  const drawPass = (mode: 'stroke' | 'fill', color: string) => {
    lines.forEach((l, i) => {
      const remaining = visible - l.start;
      if (remaining <= 0) return;
      const str = remaining >= l.text.length ? l.text : l.text.slice(0, remaining);
      if (!str) return;
      const y = originY + ascent + i * lineH;
      const x = lineX(l);
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
            const pre = measure(c, l.text.slice(0, a), spacing) + (a > 0 && !supportsLetterSpacing ? spacing : 0);
            c.fillStyle = hl.color;
            drawSpaced(c, l.text.slice(a, b), x + pre, y, spacing, 'fill');
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
