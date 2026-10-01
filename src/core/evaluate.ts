import { ease } from './easing';
import { evalProp } from './keyframes';
import { clipEnd, isVisualTrackKind } from './project';
import { nextAdjacent } from './ops';
import type {
  AdjustmentClip,
  BlendMode,
  CaptionClip,
  CaptionStyle,
  Clip,
  ColorAdjust,
  Crop,
  FitMode,
  ImageClip,
  Project,
  ShapeClip,
  TextClip,
  Track,
  VideoClip,
  VisualClip,
} from './types';
import { isVisualClip } from './types';
import { COLOR_PARAMS } from './effects';

/**
 * Turns (project, time) into a flat, fully-resolved description of what to
 * draw. Keyframes, animation presets and transitions are all resolved here so
 * the GPU renderer stays a dumb, deterministic consumer. Preview and export
 * both call this, which is what keeps them pixel-identical.
 */

export type LayerSource =
  | { kind: 'video'; assetId: string; time: number }
  | { kind: 'image'; assetId: string; /** Clip-local time (animated images loop on it). */ time: number }
  | { kind: 'text'; clip: TextClip; visibleChars: number | null }
  | { kind: 'shape'; clip: ShapeClip }
  | { kind: 'caption'; clip: CaptionClip; style: CaptionStyle; localTime: number };

export interface ResolvedEffect {
  id: string;
  type: string;
  params: Record<string, number | string | boolean>;
}

export interface ClipLayer {
  type: 'clip';
  clipId: string;
  trackId: string;
  source: LayerSource;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  crop: Crop;
  fit: FitMode;
  flipH: boolean;
  flipV: boolean;
  blendMode: BlendMode;
  cornerRadius: number;
  color: ColorAdjust;
  effects: ResolvedEffect[];
  /** Extra blur (0..100) from animation presets. */
  animBlur: number;
  /** Wipe reveal 0..1 (1 = fully visible) from animation presets, or null. */
  wipe: number | null;
  /** Seconds since the clip started (for time-based effects like grain). */
  localTime: number;
}

export interface TransitionLayer {
  type: 'transition';
  transition: string;
  progress: number;
  a: ClipLayer;
  b: ClipLayer;
  trackId: string;
}

export interface AdjustmentLayer {
  type: 'adjustment';
  clipId: string;
  trackId: string;
  color: ColorAdjust;
  effects: ResolvedEffect[];
  opacity: number;
  localTime: number;
}

export type Layer = ClipLayer | TransitionLayer | AdjustmentLayer;

export interface FrameDesc {
  time: number;
  width: number;
  height: number;
  background: string;
  /** Bottom to top. */
  layers: Layer[];
}

const ACTIVE_EPS = 1e-7;

export function isActiveAt(c: Clip, t: number): boolean {
  return t >= c.start - ACTIVE_EPS && t < clipEnd(c) - ACTIVE_EPS;
}

/** Visual tracks bottom-to-top (render order). */
export function visualTracksBottomUp(p: Project): Track[] {
  return p.tracks.filter((t) => isVisualTrackKind(t.kind)).reverse();
}

export function sourceTimeFor(p: Project, c: VideoClip, t: number): number {
  const asset = p.assets[c.assetId];
  const dur = asset?.duration ?? Infinity;
  const raw = c.freeze ? c.sourceIn : c.sourceIn + (t - c.start) * c.speed;
  // Stay a hair inside the media so the decoder always has a frame.
  const maxT = Math.max(0, dur - 1e-3);
  return Math.min(Math.max(raw, 0), maxT);
}

function resolveColor(c: VisualClip | AdjustmentClip, lt: number): ColorAdjust {
  const out: ColorAdjust = { ...c.color };
  for (const def of COLOR_PARAMS) {
    const path = `color.${def.key}`;
    if (c.keyframes[path]) out[def.key] = evalProp(c, path, lt);
  }
  return out;
}

function resolveEffects(c: VisualClip | AdjustmentClip, lt: number): ResolvedEffect[] {
  const out: ResolvedEffect[] = [];
  for (const fx of c.effects) {
    if (!fx.enabled) continue;
    const params = { ...fx.params };
    for (const key of Object.keys(params)) {
      const path = `fx.${fx.id}.${key}`;
      if (c.keyframes[path]) params[key] = evalProp(c, path, lt);
    }
    out.push({ id: fx.id, type: fx.type, params });
  }
  return out;
}

function isFullFrame(c: VisualClip): boolean {
  return c.type === 'video' || c.type === 'image';
}

/** Build a ClipLayer for a visual clip at absolute time t (may lie outside the clip for transitions). */
export function buildClipLayer(p: Project, c: VisualClip, t: number): ClipLayer {
  const rawLocal = t - c.start;
  const lt = Math.min(Math.max(rawLocal, 0), c.duration);
  let x = evalProp(c, 'transform.x', lt);
  let y = evalProp(c, 'transform.y', lt);
  let scale = evalProp(c, 'transform.scale', lt);
  let rotation = evalProp(c, 'transform.rotation', lt);
  let opacity = evalProp(c, 'transform.opacity', lt);
  const crop: Crop = {
    left: evalProp(c, 'crop.left', lt),
    right: evalProp(c, 'crop.right', lt),
    top: evalProp(c, 'crop.top', lt),
    bottom: evalProp(c, 'crop.bottom', lt),
  };
  let animBlur = 0;
  let wipe: number | null = null;
  let visibleChars: number | null = null;

  const W = p.settings.width;
  const H = p.settings.height;
  const full = isFullFrame(c);

  const applyPreset = (preset: string, pr: number, dir: 1 | -1) => {
    // pr: 0 = hidden, 1 = fully shown. dir: 1 for "in", -1 for "out".
    const inv = 1 - pr;
    switch (preset) {
      case 'fade':
        opacity *= pr;
        break;
      case 'slideLeft':
        x += (full ? W : W * 0.15) * inv * dir;
        if (!full) opacity *= pr;
        break;
      case 'slideRight':
        x -= (full ? W : W * 0.15) * inv * dir;
        if (!full) opacity *= pr;
        break;
      case 'slideUp':
        y += (full ? H : H * 0.12) * inv * dir;
        if (!full) opacity *= pr;
        break;
      case 'slideDown':
        y -= (full ? H : H * 0.12) * inv * dir;
        if (!full) opacity *= pr;
        break;
      case 'zoomIn':
        scale *= 0.6 + 0.4 * pr;
        opacity *= pr;
        break;
      case 'zoomOut':
        scale *= 1 + 0.5 * inv;
        opacity *= pr;
        break;
      case 'pop':
        scale *= ease('backOut', pr);
        opacity *= Math.min(1, pr * 3);
        break;
      case 'spin':
        rotation += -180 * inv * dir;
        scale *= pr;
        break;
      case 'blur':
        animBlur = Math.max(animBlur, inv * 60);
        opacity *= Math.min(1, 0.2 + pr);
        break;
      case 'wipe':
        wipe = Math.min(wipe ?? 1, pr);
        break;
      case 'typewriter':
      case 'wordByWord':
        if (c.type === 'text') {
          const len = c.text.length;
          if (preset === 'typewriter') {
            visibleChars = Math.min(visibleChars ?? len, Math.floor(len * pr + 1e-9));
          } else {
            // Reveal whole words.
            const words = c.text.split(/(\s+)/);
            const wordCount = words.filter((w) => w.trim()).length;
            const shown = Math.ceil(wordCount * pr - 1e-9);
            let chars = 0;
            let seen = 0;
            for (const w of words) {
              if (w.trim()) {
                if (seen >= shown) break;
                seen++;
              }
              chars += w.length;
            }
            visibleChars = Math.min(visibleChars ?? len, chars);
          }
        } else {
          opacity *= pr;
        }
        break;
    }
  };

  if (c.animIn.preset !== 'none' && c.animIn.duration > 0) {
    const d = Math.min(c.animIn.duration, c.duration);
    const pr = ease('easeOut', Math.min(1, Math.max(0, rawLocal / d)));
    if (pr < 1) applyPreset(c.animIn.preset, pr, 1);
  }
  if (c.animOut.preset !== 'none' && c.animOut.duration > 0) {
    const d = Math.min(c.animOut.duration, c.duration);
    const pr = ease('easeIn', Math.min(1, Math.max(0, (c.duration - rawLocal) / d)));
    if (pr < 1) applyPreset(c.animOut.preset, pr, -1);
  }

  let source: LayerSource;
  switch (c.type) {
    case 'video':
      source = { kind: 'video', assetId: c.assetId, time: sourceTimeFor(p, c, t) };
      break;
    case 'image':
      source = { kind: 'image', assetId: (c as ImageClip).assetId, time: rawLocal };
      break;
    case 'text':
      source = { kind: 'text', clip: c, visibleChars };
      break;
    case 'shape':
      source = { kind: 'shape', clip: c };
      break;
  }

  return {
    type: 'clip',
    clipId: c.id,
    trackId: c.trackId,
    source,
    x,
    y,
    scale,
    rotation,
    opacity: Math.max(0, Math.min(1, opacity)),
    crop,
    fit: c.fit,
    flipH: c.flipH,
    flipV: c.flipV,
    blendMode: c.blendMode,
    cornerRadius: c.cornerRadius,
    color: resolveColor(c, lt),
    effects: resolveEffects(c, lt),
    animBlur,
    wipe,
    localTime: rawLocal,
  };
}

function captionLayer(track: Track, c: CaptionClip, t: number): ClipLayer {
  const style = track.captionStyle!;
  return {
    type: 'clip',
    clipId: c.id,
    trackId: track.id,
    source: { kind: 'caption', clip: c, style, localTime: t - c.start },
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    crop: { left: 0, right: 0, top: 0, bottom: 0 },
    fit: 'none',
    flipH: false,
    flipV: false,
    blendMode: 'normal',
    cornerRadius: 0,
    color: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, vibrance: 0, hue: 0 },
    effects: [],
    animBlur: 0,
    wipe: null,
    localTime: t - c.start,
  };
}

function adjustmentLayer(c: AdjustmentClip, t: number): AdjustmentLayer {
  const lt = Math.min(Math.max(t - c.start, 0), c.duration);
  return {
    type: 'adjustment',
    clipId: c.id,
    trackId: c.trackId,
    color: resolveColor(c, lt),
    effects: resolveEffects(c, lt),
    opacity: evalProp(c, 'opacity', lt),
    localTime: t - c.start,
  };
}

/** Index clips by track once per evaluation (cheap; clip counts are modest). */
function clipsByTrack(p: Project): Map<string, Clip[]> {
  const m = new Map<string, Clip[]>();
  for (const c of Object.values(p.clips)) {
    let arr = m.get(c.trackId);
    if (!arr) m.set(c.trackId, (arr = []));
    arr.push(c);
  }
  return m;
}

export interface EvaluateOptions {
  /** Render even hidden tracks (unused in normal operation). */
  includeHidden?: boolean;
  /** Restrict to these clip ids (e.g. for thumbnails). */
  onlyClipIds?: Set<string>;
}

export function evaluateFrame(p: Project, t: number, opts: EvaluateOptions = {}): FrameDesc {
  const layers: Layer[] = [];
  const byTrack = clipsByTrack(p);
  for (const track of visualTracksBottomUp(p)) {
    if (track.hidden && !opts.includeHidden) continue;
    const clips = (byTrack.get(track.id) ?? []).filter((c) => !c.disabled && (!opts.onlyClipIds || opts.onlyClipIds.has(c.id)));
    if (clips.length === 0) continue;

    if (track.kind === 'caption') {
      for (const c of clips) {
        if (c.type === 'caption' && isActiveAt(c, t) && track.captionStyle) layers.push(captionLayer(track, c, t));
      }
      continue;
    }

    // Active transition on this track?
    let handled = false;
    for (const a of clips) {
      if (!isVisualClip(a) || !a.transitionOut) continue;
      const d = a.transitionOut.duration;
      const cut = clipEnd(a);
      if (t < cut - d / 2 - ACTIVE_EPS || t >= cut + d / 2 - ACTIVE_EPS) continue;
      const b = nextAdjacent(p, a);
      if (!b || !isVisualClip(b) || b.disabled) continue;
      const progress = Math.min(1, Math.max(0, (t - (cut - d / 2)) / d));
      layers.push({
        type: 'transition',
        transition: a.transitionOut.type,
        progress,
        a: buildClipLayer(p, a, t),
        b: buildClipLayer(p, b, t),
        trackId: track.id,
      });
      handled = true;
      break;
    }
    if (handled) continue;

    for (const c of clips) {
      if (!isActiveAt(c, t)) continue;
      if (c.type === 'adjustment') layers.push(adjustmentLayer(c, t));
      else if (isVisualClip(c)) layers.push(buildClipLayer(p, c, t));
      break; // one clip per track at a time
    }
  }
  return { time: t, width: p.settings.width, height: p.settings.height, background: p.settings.background, layers };
}

/** All video sources needed for a frame (used to prefetch decoders). */
export function videoSourcesIn(desc: FrameDesc): { assetId: string; time: number; key: string }[] {
  const out: { assetId: string; time: number; key: string }[] = [];
  const visit = (l: ClipLayer) => {
    if (l.source.kind === 'video') out.push({ assetId: l.source.assetId, time: l.source.time, key: l.clipId });
  };
  for (const l of desc.layers) {
    if (l.type === 'clip') visit(l);
    else if (l.type === 'transition') {
      visit(l.a);
      visit(l.b);
    }
  }
  return out;
}
