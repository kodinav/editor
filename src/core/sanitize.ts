import { EASINGS } from './easing';
import { EFFECT_MAP, NEUTRAL_COLOR } from './effects';
import { uid } from './ids';
import { defaultAudioProps, defaultCaptionStyle, defaultTextStyle, defaultVisualProps } from './project';
import { TRANSITION_MAP } from './transitions';
import type {
  AnimationPreset,
  Asset,
  AudioProps,
  BlendMode,
  CaptionStyle,
  CaptionWord,
  Clip,
  ClipAnimation,
  ColorAdjust,
  Crop,
  Effect,
  FitMode,
  KeyframeMap,
  Marker,
  ShapeKind,
  TextStyle,
  Track,
  Transform,
  TransitionSpec,
  VisualProps,
} from './types';

/**
 * Repairs project data field by field: every value must have the type the app
 * expects, numbers must be finite and within sane bounds, and references must
 * resolve. Valid projects pass through unchanged; corrupted or hostile ones
 * come out safe to render, mix and edit.
 */

/** Longest time anything may sit on the timeline (seconds, ~11.5 days). */
export const MAX_TIME = 1e6;

type Loose = Record<string, unknown>;

export const obj = (v: unknown): Loose => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : {});
const isObj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown, d: number, min: number, max: number) => (finite(v) ? Math.min(max, Math.max(min, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const str = (v: unknown, d: string, max = 1000) => (typeof v === 'string' ? v.slice(0, max) : d);
const oneOf = <T extends string>(v: unknown, allowed: Record<T, unknown>, d: T): T => (typeof v === 'string' && Object.hasOwn(allowed, v) ? (v as T) : d);
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const color = (v: unknown, d: string) => (typeof v === 'string' && HEX.test(v) ? v : d);
const colorOrNull = (v: unknown, d: string | null) => (v === null ? null : typeof v === 'string' && HEX.test(v) ? v : d);
const id = (v: unknown, prefix: string) => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : uid(prefix));

const PRESETS: Record<AnimationPreset, true> = {
  none: true, fade: true, slideLeft: true, slideRight: true, slideUp: true, slideDown: true, zoomIn: true,
  zoomOut: true, pop: true, spin: true, blur: true, wipe: true, typewriter: true, wordByWord: true,
};
const FITS: Record<FitMode, true> = { contain: true, cover: true, fill: true, none: true };
const BLENDS: Record<BlendMode, true> = {
  normal: true, multiply: true, screen: true, overlay: true, darken: true, lighten: true, add: true, difference: true, softLight: true,
};
const SHAPES: Record<ShapeKind, true> = { rectangle: true, ellipse: true, triangle: true, star: true, line: true, arrow: true };
const EASE = Object.fromEntries(EASINGS.map((e) => [e.id, true])) as Record<(typeof EASINGS)[number]['id'], true>;
const ALIGN = { left: true, center: true, right: true } as const;
const POSITION = { bottom: true, middle: true, top: true } as const;
const ROTATIONS: Record<string, 0 | 90 | 180 | 270> = { 0: 0, 90: 90, 180: 180, 270: 270 };
const DENOISE = { light: true, medium: true, strong: true } as const;

function transform(v: unknown): Transform {
  const o = obj(v);
  return {
    x: num(o.x, 0, -1e5, 1e5),
    y: num(o.y, 0, -1e5, 1e5),
    scale: num(o.scale, 1, 0, 100),
    rotation: num(o.rotation, 0, -36000, 36000),
    opacity: num(o.opacity, 1, 0, 1),
  };
}

function crop(v: unknown): Crop {
  const o = obj(v);
  const c = { left: num(o.left, 0, 0, 0.95), right: num(o.right, 0, 0, 0.95), top: num(o.top, 0, 0, 0.95), bottom: num(o.bottom, 0, 0, 0.95) };
  // Insets that leave nothing visible are reset rather than producing an empty layer.
  if (c.left + c.right > 0.95) c.left = c.right = 0;
  if (c.top + c.bottom > 0.95) c.top = c.bottom = 0;
  return c;
}

export function colorAdjust(v: unknown): ColorAdjust {
  const o = obj(v);
  const out = { ...NEUTRAL_COLOR };
  for (const k of Object.keys(NEUTRAL_COLOR) as (keyof ColorAdjust)[]) out[k] = num(o[k], 0, k === 'hue' ? -360 : -10, k === 'hue' ? 360 : 10);
  return out;
}

export function effects(v: unknown): Effect[] {
  const out: Effect[] = [];
  const seen = new Set<string>();
  for (const e of arr(v).slice(0, 64)) {
    const o = obj(e);
    const def = typeof o.type === 'string' ? EFFECT_MAP[o.type] : undefined;
    if (!def) continue;
    const given = obj(o.params);
    const params: Effect['params'] = {};
    for (const p of def.params) {
      if (p.kind === 'number') params[p.key] = num(given[p.key], p.default, p.min, p.max);
      else if (p.kind === 'color') params[p.key] = color(given[p.key], p.default);
      else if (p.kind === 'boolean') params[p.key] = bool(given[p.key], p.default);
      else params[p.key] = p.options.some((x) => x.value === given[p.key]) ? (given[p.key] as string) : p.default;
    }
    let fxId = id(o.id, 'fx');
    if (seen.has(fxId)) fxId = uid('fx');
    seen.add(fxId);
    out.push({ id: fxId, type: def.type, enabled: bool(o.enabled, true), params });
  }
  return out;
}

function animation(v: unknown): ClipAnimation {
  const o = obj(v);
  return { preset: oneOf(o.preset, PRESETS, 'none'), duration: num(o.duration, 0.5, 0, 60) };
}

function transition(v: unknown): TransitionSpec | undefined {
  const o = obj(v);
  if (typeof o.type !== 'string' || !TRANSITION_MAP[o.type] || !finite(o.duration) || o.duration <= 0) return undefined;
  return { type: o.type, duration: Math.min(60, o.duration) };
}

function keyframes(v: unknown): KeyframeMap {
  const out: KeyframeMap = {};
  for (const [path, list] of Object.entries(obj(v)).slice(0, 500)) {
    if (path.length > 200) continue;
    const kfs = arr(list)
      .slice(0, 10000)
      .flatMap((k) => {
        const o = obj(k);
        if (!finite(o.t) || !finite(o.v)) return [];
        return [{ id: id(o.id, 'kf'), t: num(o.t, 0, -MAX_TIME, MAX_TIME), v: num(o.v, 0, -1e6, 1e6), ease: oneOf(o.ease, EASE, 'linear') }];
      })
      .sort((a, b) => a.t - b.t);
    if (kfs.length) out[path] = kfs;
  }
  return out;
}

export function textStyle(v: unknown, d: TextStyle = defaultTextStyle()): TextStyle {
  const o = obj(v);
  return {
    fontFamily: str(o.fontFamily, d.fontFamily, 200),
    fontWeight: num(o.fontWeight, d.fontWeight, 100, 1000),
    italic: bool(o.italic, d.italic),
    fontSize: num(o.fontSize, d.fontSize, 1, 4000),
    color: color(o.color, d.color),
    align: oneOf(o.align, ALIGN, d.align),
    lineHeight: num(o.lineHeight, d.lineHeight, 0.1, 10),
    letterSpacing: num(o.letterSpacing, d.letterSpacing, -1, 10),
    uppercase: bool(o.uppercase, d.uppercase),
    strokeColor: color(o.strokeColor, d.strokeColor),
    strokeWidth: num(o.strokeWidth, d.strokeWidth, 0, 500),
    shadowColor: color(o.shadowColor, d.shadowColor),
    shadowBlur: num(o.shadowBlur, d.shadowBlur, 0, 500),
    shadowX: num(o.shadowX, d.shadowX, -2000, 2000),
    shadowY: num(o.shadowY, d.shadowY, -2000, 2000),
    backgroundColor: colorOrNull(o.backgroundColor, d.backgroundColor),
    backgroundOpacity: num(o.backgroundOpacity, d.backgroundOpacity, 0, 1),
    backgroundPadding: num(o.backgroundPadding, d.backgroundPadding, 0, 5),
    backgroundRadius: num(o.backgroundRadius, d.backgroundRadius, 0, 1),
    maxWidth: num(o.maxWidth, d.maxWidth, 0.05, 4),
  };
}

export function captionStyle(v: unknown): CaptionStyle {
  const d = defaultCaptionStyle();
  const o = obj(v);
  return {
    ...textStyle(o, d),
    position: oneOf(o.position, POSITION, d.position),
    margin: num(o.margin, d.margin, 0, 0.5),
    activeWordColor: colorOrNull(o.activeWordColor, d.activeWordColor),
  };
}

function visual(o: Loose, defaults: Partial<VisualProps> = {}): VisualProps {
  const d = { ...defaultVisualProps(), ...defaults };
  const out: VisualProps = {
    transform: transform(o.transform),
    crop: crop(o.crop),
    fit: oneOf(o.fit, FITS, d.fit),
    flipH: bool(o.flipH, false),
    flipV: bool(o.flipV, false),
    blendMode: oneOf(o.blendMode, BLENDS, 'normal'),
    color: colorAdjust(o.color),
    effects: effects(o.effects),
    animIn: animation(o.animIn),
    animOut: animation(o.animOut),
    cornerRadius: num(o.cornerRadius, 0, 0, 0.5),
  };
  const t = transition(o.transitionOut);
  if (t) out.transitionOut = t;
  return out;
}

function audio(o: Loose, duration: number): AudioProps {
  const d = defaultAudioProps();
  return {
    volume: num(o.volume, d.volume, 0, 16),
    denoise: bool(o.denoise, d.denoise),
    pan: num(o.pan, d.pan, -1, 1),
    fadeIn: num(o.fadeIn, 0, 0, duration),
    fadeOut: num(o.fadeOut, 0, 0, duration),
    muted: bool(o.muted, d.muted),
  };
}

function words(v: unknown): CaptionWord[] | undefined {
  // Timings may run slightly past the clip (speech isn't cut at frame edges); only order matters.
  const out = arr(v)
    .slice(0, 5000)
    .flatMap((w) => {
      const o = obj(w);
      if (typeof o.text !== 'string' || !finite(o.start) || !finite(o.end)) return [];
      const start = num(o.start, 0, -MAX_TIME, MAX_TIME);
      return [{ text: o.text.slice(0, 200), start, end: num(o.end, start, start, MAX_TIME) }];
    })
    .sort((a, b) => a.start - b.start);
  return out.length ? out : undefined;
}

/**
 * A clip with every field checked, or null when it can't be used (unknown
 * type, missing or mismatched media). `raw` has passed the structural schema.
 */
export function sanitizeClip(raw: Loose, assets: Record<string, Asset>): Clip | null {
  const start = num(raw.start, 0, 0, MAX_TIME - 1);
  const duration = num(raw.duration, 1, 1e-3, MAX_TIME - start);
  const base = {
    id: raw.id as string,
    trackId: raw.trackId as string,
    start,
    duration,
    name: str(raw.name, String(raw.type), 300),
    keyframes: keyframes(raw.keyframes),
    ...(typeof raw.labelColor === 'string' && HEX.test(raw.labelColor) ? { labelColor: raw.labelColor } : {}),
    ...(typeof raw.disabled === 'boolean' ? { disabled: raw.disabled } : {}),
  };
  const asset = typeof raw.assetId === 'string' ? assets[raw.assetId] : undefined;
  const media = () => ({
    assetId: asset!.id,
    sourceIn: num(raw.sourceIn, 0, 0, MAX_TIME),
    speed: num(raw.speed, 1, 0.1, 16),
    preservePitch: bool(raw.preservePitch, true),
  });
  switch (raw.type) {
    case 'video':
      if (asset?.kind !== 'video') return null;
      return { ...base, type: 'video', ...visual(raw), ...audio(raw, duration), ...media(), ...(typeof raw.freeze === 'boolean' ? { freeze: raw.freeze } : {}) };
    case 'audio':
      // Detached audio keeps pointing at its video file.
      if (!asset?.audio || (asset.kind !== 'audio' && asset.kind !== 'video')) return null;
      return { ...base, type: 'audio', ...audio(raw, duration), ...media() };
    case 'image':
      if (asset?.kind !== 'image') return null;
      return { ...base, type: 'image', assetId: asset.id, ...visual(raw) };
    case 'text':
      return { ...base, type: 'text', text: str(raw.text, '', 100_000), style: textStyle(raw.style), ...visual(raw, { fit: 'none' }) };
    case 'shape':
      return {
        ...base,
        type: 'shape',
        ...visual(raw, { fit: 'none' }),
        shape: oneOf(raw.shape, SHAPES, 'rectangle'),
        width: num(raw.width, 400, 1, 16384),
        height: num(raw.height, 400, 1, 16384),
        fill: color(raw.fill, '#4f8cff'),
        fill2: colorOrNull(raw.fill2, null),
        gradientAngle: num(raw.gradientAngle, 90, -3600, 3600),
        strokeColor: color(raw.strokeColor, '#ffffff'),
        strokeWidth: num(raw.strokeWidth, 0, 0, 1000),
        radius: num(raw.radius, 0, 0, 8192),
      };
    case 'adjustment':
      return { ...base, type: 'adjustment', color: colorAdjust(raw.color), effects: effects(raw.effects), opacity: num(raw.opacity, 1, 0, 1) };
    case 'caption': {
      const w = words(raw.words);
      return { ...base, type: 'caption', text: str(raw.text, '', 10_000), ...(w ? { words: w } : {}) };
    }
    default:
      return null;
  }
}

/** An asset with checked metadata, or null when it's unusable. `raw` has passed the structural schema. */
export function sanitizeAsset(raw: Loose): Asset | null {
  const out: Asset = {
    id: raw.id as string,
    kind: raw.kind as Asset['kind'],
    name: str(raw.name, 'Media', 512),
    mimeType: str(raw.mimeType, '', 256),
    size: num(raw.size, 0, 0, Number.MAX_SAFE_INTEGER),
    lastModified: num(raw.lastModified, 0, 0, Number.MAX_SAFE_INTEGER),
    duration: num(raw.duration, 0, 0, MAX_TIME),
    status: raw.status as Asset['status'],
    stored: raw.stored === true,
    createdAt: num(raw.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
  };
  if (typeof raw.error === 'string') out.error = raw.error.slice(0, 1000);
  const v = obj(raw.video);
  if (isObj(raw.video)) {
    if (!finite(v.width) || !finite(v.height) || v.width < 1 || v.height < 1) return null;
    out.video = {
      width: Math.min(16384, Math.round(v.width)),
      height: Math.min(16384, Math.round(v.height)),
      rotation: ROTATIONS[String(v.rotation)] ?? 0,
      fps: num(v.fps, 30, 0.1, 1000),
      codec: typeof v.codec === 'string' ? v.codec.slice(0, 100) : null,
      hasAlpha: bool(v.hasAlpha, false),
    };
  }
  const a = obj(raw.audio);
  if (isObj(raw.audio)) {
    out.audio = {
      sampleRate: Math.round(num(a.sampleRate, 48000, 1000, 768000)),
      channels: Math.round(num(a.channels, 2, 1, 64)),
      codec: typeof a.codec === 'string' ? a.codec.slice(0, 100) : null,
      conformed: bool(a.conformed, false),
    };
    if (typeof a.denoise === 'string' && Object.hasOwn(DENOISE, a.denoise)) out.audio.denoise = a.denoise as 'light' | 'medium' | 'strong';
  }
  const im = obj(raw.image);
  if (isObj(raw.image)) {
    if (!finite(im.width) || !finite(im.height) || im.width < 1 || im.height < 1) return null;
    out.image = { width: Math.min(65536, Math.round(im.width)), height: Math.min(65536, Math.round(im.height)) };
    if (typeof im.animated === 'boolean') out.image.animated = im.animated;
  }
  if (isObj(raw.font)) {
    const family = obj(raw.font).family;
    if (typeof family !== 'string' || !family) return null;
    out.font = { family: family.slice(0, 200) };
  }
  // Each kind needs the metadata the renderer and mixer rely on.
  if (out.kind === 'video' && !out.video) return null;
  if (out.kind === 'audio' && !out.audio) return null;
  if (out.kind === 'image' && !out.image) return null;
  if (out.kind === 'font' && !out.font) return null;
  return out;
}

export function sanitizeTrack(raw: Loose): Track {
  const kind = raw.kind as Track['kind'];
  const t: Track = {
    id: raw.id as string,
    kind,
    name: str(raw.name, 'Track', 200),
    hidden: bool(raw.hidden, false),
    muted: bool(raw.muted, false),
    locked: bool(raw.locked, false),
    volume: num(raw.volume, 1, 0, 16),
    height: num(raw.height, kind === 'audio' ? 56 : kind === 'caption' ? 40 : 64, 24, 400),
  };
  if (kind === 'caption') t.captionStyle = captionStyle(raw.captionStyle);
  return t;
}

export function sanitizeMarkers(v: unknown): Marker[] {
  return arr(v)
    .slice(0, 10000)
    .flatMap((m) => {
      const o = obj(m);
      if (!finite(o.t)) return [];
      return [{ id: id(o.id, 'mk'), t: num(o.t, 0, 0, MAX_TIME), label: str(o.label, '', 200), color: color(o.color, '#f5c542') }];
    });
}

/** In/out points as a valid range (or cleared). */
export function sanitizeRange(inPoint: unknown, outPoint: unknown): { inPoint: number | null; outPoint: number | null } {
  const i = finite(inPoint) ? num(inPoint, 0, 0, MAX_TIME) : null;
  const o = finite(outPoint) ? num(outPoint, 0, 0, MAX_TIME) : null;
  if (i !== null && o !== null && o <= i) return { inPoint: null, outPoint: null };
  return { inPoint: i, outPoint: o };
}

export { num as clampNumber, str as cleanString };
