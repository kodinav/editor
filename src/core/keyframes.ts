import { ease } from './easing';
import { uid } from './ids';
import type { Clip, Easing, Keyframe, KeyframeMap } from './types';

/**
 * Animatable properties are addressed by a dotted path into the clip object,
 * e.g. "transform.x", "volume", "color.exposure". Effect parameters use
 * "fx.<effectId>.<param>". Keyframes are stored per path on the clip and
 * override the static value while present.
 */

export const KF_EPS = 1 / 2000;

export function getStaticValue(clip: Clip, path: string): number {
  if (path.startsWith('fx.')) {
    const [, effectId, param] = path.split('.');
    const effects = 'effects' in clip ? clip.effects : [];
    const fx = effects.find((e) => e.id === effectId);
    const v = fx?.params[param];
    return typeof v === 'number' ? v : 0;
  }
  let cur: unknown = clip;
  for (const key of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return 0;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'number' ? cur : 0;
}

/** Mutates `clip` (use inside an immer producer). */
export function setStaticValue(clip: Clip, path: string, value: number): void {
  if (path.startsWith('fx.')) {
    const [, effectId, param] = path.split('.');
    const effects = 'effects' in clip ? clip.effects : [];
    const fx = effects.find((e) => e.id === effectId);
    if (fx) fx.params[param] = value;
    return;
  }
  const keys = path.split('.');
  let cur = clip as unknown as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const next = cur[keys[i]];
    if (next == null || typeof next !== 'object') return;
    cur = next as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

/** Interpolate a keyframe track at local time t (seconds from clip start). */
export function sampleKeyframes(kfs: Keyframe[], t: number): number {
  const n = kfs.length;
  if (n === 0) return 0;
  if (t <= kfs[0].t) return kfs[0].v;
  if (t >= kfs[n - 1].t) return kfs[n - 1].v;
  // Binary search for the segment containing t.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = kfs[lo];
  const b = kfs[hi];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const p = ease(a.ease, (t - a.t) / span);
  return a.v + (b.v - a.v) * p;
}

/** Value of an animatable property at a local clip time. */
export function evalProp(clip: Clip, path: string, localT: number): number {
  const kfs = clip.keyframes[path];
  if (kfs && kfs.length > 0) return sampleKeyframes(kfs, localT);
  return getStaticValue(clip, path);
}

export function hasKeyframes(clip: Clip, path: string): boolean {
  return (clip.keyframes[path]?.length ?? 0) > 0;
}

export function keyframeAt(clip: Clip, path: string, localT: number): Keyframe | undefined {
  return clip.keyframes[path]?.find((k) => Math.abs(k.t - localT) < KF_EPS * 20);
}

/**
 * Set a property value at a time. If the property is animated, inserts or
 * updates a keyframe; otherwise writes the static value. Mutates `clip`.
 */
export function writeProp(clip: Clip, path: string, localT: number, value: number): void {
  const kfs = clip.keyframes[path];
  if (kfs && kfs.length > 0) {
    upsertKeyframe(clip, path, localT, value);
  } else {
    setStaticValue(clip, path, value);
  }
}

export function upsertKeyframe(
  clip: Clip,
  path: string,
  localT: number,
  value: number,
  easing: Easing = 'easeInOut',
): Keyframe {
  const list = (clip.keyframes[path] ??= []);
  const existing = list.find((k) => Math.abs(k.t - localT) < KF_EPS * 20);
  if (existing) {
    existing.v = value;
    return existing;
  }
  const kf: Keyframe = { id: uid('kf'), t: localT, v: value, ease: easing };
  list.push(kf);
  list.sort((a, b) => a.t - b.t);
  return kf;
}

export function removeKeyframe(clip: Clip, path: string, kfId: string): void {
  const list = clip.keyframes[path];
  if (!list) return;
  const idx = list.findIndex((k) => k.id === kfId);
  if (idx < 0) return;
  const removed = list[idx];
  list.splice(idx, 1);
  if (list.length === 0) {
    // When the last keyframe goes away, keep its value as the static value.
    setStaticValue(clip, path, removed.v);
    delete clip.keyframes[path];
  }
}

/**
 * Turn animation on for a property: creates a keyframe at `localT` holding the
 * current value. Turning it off collapses to the value at `localT`.
 */
export function toggleAnimation(clip: Clip, path: string, localT: number): void {
  if (hasKeyframes(clip, path)) {
    const v = evalProp(clip, path, localT);
    delete clip.keyframes[path];
    setStaticValue(clip, path, v);
  } else {
    upsertKeyframe(clip, path, localT, getStaticValue(clip, path));
  }
}

/** Shift all keyframes by dt (used when trimming a clip's head). */
export function shiftKeyframes(map: KeyframeMap, dt: number): void {
  for (const key of Object.keys(map)) {
    for (const k of map[key]) k.t += dt;
  }
}

/**
 * Drop keyframes far outside [0, duration] while keeping the nearest one on
 * each side so interpolation inside the range is unchanged.
 */
export function pruneKeyframes(map: KeyframeMap, duration: number): void {
  for (const key of Object.keys(map)) {
    const list = map[key];
    let firstInside = list.findIndex((k) => k.t >= 0);
    if (firstInside < 0) firstInside = list.length;
    const startIdx = Math.max(0, firstInside - 1);
    let lastInside = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].t <= duration) {
        lastInside = i;
        break;
      }
    }
    const endIdx = Math.min(list.length - 1, lastInside + 1);
    map[key] = endIdx >= startIdx ? list.slice(startIdx, endIdx + 1) : [];
    if (map[key].length === 0) delete map[key];
  }
}

/** Collect sorted unique keyframe times across all properties of a clip. */
export function allKeyframeTimes(clip: Clip): number[] {
  const times: number[] = [];
  for (const list of Object.values(clip.keyframes)) for (const k of list) times.push(k.t);
  times.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of times) if (out.length === 0 || Math.abs(out[out.length - 1] - t) > KF_EPS) out.push(t);
  return out;
}
