import { clipEnd } from '@/core/project';
import type { Project, Track } from '@/core/types';

/** Shared timeline geometry. */

export const RULER_H = 28;
export const HEADER_W = 168;
export const HEADER_W_COMPACT = 92;
export const SECTION_GAP = 6;
export const BOTTOM_PAD = 40;

export interface TrackRowLayout {
  track: Track;
  top: number;
  height: number;
  index: number;
}

/** Vertical layout of track rows (y relative to the area below the ruler). */
export function layoutTracks(p: Project): { rows: TrackRowLayout[]; total: number; audioStart: number } {
  const rows: TrackRowLayout[] = [];
  let y = 0;
  let audioStart = -1;
  p.tracks.forEach((track, index) => {
    if (track.kind === 'audio' && audioStart < 0) {
      if (index > 0) y += SECTION_GAP;
      audioStart = y;
    }
    rows.push({ track, top: y, height: track.height, index });
    y += track.height;
  });
  return { rows, total: y, audioStart: audioStart < 0 ? y : audioStart };
}

export function rowAtY(rows: TrackRowLayout[], y: number): TrackRowLayout | null {
  for (const r of rows) if (y >= r.top && y < r.top + r.height) return r;
  return null;
}

/** All times a dragged edge can snap to. */
export function snapPoints(p: Project, exclude: Set<string>, playhead: number): number[] {
  const pts = new Set<number>([0, playhead]);
  for (const c of Object.values(p.clips)) {
    if (exclude.has(c.id)) continue;
    pts.add(c.start);
    pts.add(clipEnd(c));
  }
  for (const m of p.markers) pts.add(m.t);
  if (p.inPoint !== null) pts.add(p.inPoint);
  if (p.outPoint !== null) pts.add(p.outPoint);
  return [...pts].sort((a, b) => a - b);
}

/**
 * Find the smallest adjustment that snaps any of `edges` (after adding dt) to a
 * snap point within `threshold` seconds.
 */
export function snapDelta(edges: number[], dt: number, points: number[], threshold: number): { dt: number; at: number | null } {
  let best = Infinity;
  let at: number | null = null;
  for (const e of edges) {
    const pos = e + dt;
    // Binary search nearest point.
    let lo = 0;
    let hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    for (const i of [lo - 1, lo]) {
      const p = points[i];
      if (p === undefined) continue;
      const d = p - pos;
      if (Math.abs(d) < Math.abs(best) && Math.abs(d) <= threshold) {
        best = d;
        at = p;
      }
    }
  }
  return at === null ? { dt, at: null } : { dt: dt + best, at };
}

/** Choose a ruler tick interval for the zoom level. */
export function tickInterval(pxPerSec: number, fps: number): { major: number; minor: number } {
  const frame = 1 / fps;
  const candidates = [frame, 2 * frame, 5 * frame, 10 * frame, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const c of candidates) {
    if (c * pxPerSec >= 90) {
      const minor = c >= 1 ? c / (c % 5 === 0 ? 5 : c % 2 === 0 ? 2 : 4) : c / 5;
      return { major: c, minor: Math.max(minor, frame) };
    }
  }
  return { major: 3600, minor: 600 };
}

export function formatRuler(t: number, major: number): string {
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const whole = Math.floor(t + 1e-6);
  const s = whole % 60;
  const base = h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  if (major >= 1) return base;
  // Sub-second ticks: decimal seconds ("0:01.5") rather than frame counts that read like minutes.
  const frac = t - whole;
  if (frac < 1e-6) return base;
  const digits = major >= 0.1 ? 1 : 2;
  return `${base}${frac.toFixed(digits).slice(1)}`;
}
