import type { Keyframe } from './types';
import type { Region } from './silence';

/**
 * Auto-ducking: turn "where is someone talking" intervals into volume
 * keyframes for a music clip. Pure and deterministic; the analysis that
 * finds speech lives in state/duckingTools.ts.
 */

export interface DuckOptions {
  /** Gain reduction while speech is present (dB, negative). */
  amountDb: number;
  /** Ramp down before speech starts (s). */
  attack: number;
  /** Ramp back up after speech ends (s). */
  release: number;
}

export const DEFAULT_DUCK: DuckOptions = { amountDb: -15, attack: 0.25, release: 0.6 };

/** Merge activity intervals that are closer than `gap` and drop blips shorter than `minLen`. */
export function mergeActivity(regions: Region[], gap = 0.5, minLen = 0.2): Region[] {
  const sorted = [...regions].sort((a, b) => a.start - b.start);
  const out: Region[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start - last.end <= gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out.filter((r) => r.end - r.start >= minLen);
}

/**
 * Volume keyframes (clip-local seconds) that hold `base` gain and dip to
 * base·10^(amount/20) during each region, with linear ramps.
 */
export function duckKeyframes(regions: Region[], clipDuration: number, base: number, opts: DuckOptions, makeId: () => string): Keyframe[] {
  const low = base * Math.pow(10, opts.amountDb / 20);
  // Expand each region by its ramps and merge overlaps so ramps never cross.
  const spans = mergeActivity(
    regions.map((r) => ({ start: r.start - opts.attack, end: r.end + opts.release })),
    0,
    0,
  )
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(clipDuration, r.end) }))
    .filter((r) => r.end > r.start);
  const pts: { t: number; v: number }[] = [{ t: 0, v: base }];
  for (const s of spans) {
    const downEnd = Math.min(s.end, s.start + opts.attack);
    const upStart = Math.max(downEnd, s.end - opts.release);
    const startsAtZero = s.start <= 1e-6;
    pts.push({ t: s.start, v: startsAtZero ? low : base });
    pts.push({ t: downEnd, v: low });
    pts.push({ t: upStart, v: low });
    pts.push({ t: s.end, v: s.end >= clipDuration - 1e-6 ? low : base });
  }
  pts.push({ t: clipDuration, v: pts[pts.length - 1].v });
  // Sort, de-duplicate equal times (later point wins), drop redundant middles.
  pts.sort((a, b) => a.t - b.t);
  const dedup: { t: number; v: number }[] = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.t - p.t) < 1e-4) last.v = p.v;
    else dedup.push({ ...p });
  }
  const simplified = dedup.filter((p, i, a) => i === 0 || i === a.length - 1 || !(a[i - 1].v === p.v && a[i + 1].v === p.v));
  return simplified.map((p) => ({ id: makeId(), t: p.t, v: p.v, ease: 'linear' as const }));
}
