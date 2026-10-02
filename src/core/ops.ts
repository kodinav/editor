import { deepClone } from './clone';
import { uid } from './ids';
import { pruneKeyframes, shiftKeyframes } from './keyframes';
import {
  clipEnd,
  clipsOnTrack,
  createAudioClip,
  createTrack,
  isVisualTrackKind,
  nextTrackName,
  trackAccepts,
  trackById,
} from './project';
import { EPS, snapToFrame } from './time';
import type { AudioClip, Clip, ID, Project, Track, TrackKind, VideoClip } from './types';
import { hasSourceTiming, isVisualClip } from './types';

/**
 * Editing operations. Each function mutates a Project in place and is meant to
 * run inside an immer producer, so callers get structural sharing and undo for
 * free. Clip start/duration are always kept on the project frame grid.
 */

export const MIN_CLIP_FRAMES = 1;

export function q(p: Project, t: number): number {
  return snapToFrame(t, p.settings.fps);
}

export function minDuration(p: Project): number {
  return MIN_CLIP_FRAMES / p.settings.fps;
}

/** Maximum timeline duration a media clip can have from its current sourceIn. */
export function maxDurationFor(p: Project, c: Clip): number {
  if (!hasSourceTiming(c)) return Infinity;
  if (c.type === 'video' && c.freeze) return Infinity;
  const asset = p.assets[c.assetId];
  if (!asset || asset.duration <= 0) return Infinity;
  return Math.max(0, (asset.duration - c.sourceIn) / c.speed);
}

/** How far (timeline seconds) the head of a media clip may be extended to the left. */
export function maxHeadExtension(c: Clip): number {
  if (!hasSourceTiming(c)) return Infinity;
  if (c.type === 'video' && c.freeze) return Infinity;
  return c.sourceIn / c.speed;
}

function cloneClip<T extends Clip>(c: T): T {
  return deepClone(c);
}

/**
 * Split a clip at absolute timeline time t. Returns the id of the right-hand
 * piece, or null if t is not strictly inside the clip.
 */
export function splitClip(p: Project, clipId: ID, t: number): ID | null {
  const c = p.clips[clipId];
  if (!c) return null;
  t = q(p, t);
  const offset = t - c.start;
  const md = minDuration(p);
  if (offset < md - EPS || c.duration - offset < md - EPS) return null;

  const right = cloneClip(c);
  right.id = uid('clp');
  right.start = t;
  right.duration = c.duration - offset;
  shiftKeyframes(right.keyframes, -offset);
  pruneKeyframes(right.keyframes, right.duration);

  c.duration = offset;
  pruneKeyframes(c.keyframes, c.duration);

  if (hasSourceTiming(right) && hasSourceTiming(c)) {
    if (!(right.type === 'video' && right.freeze)) right.sourceIn = c.sourceIn + offset * c.speed;
    right.fadeIn = 0;
    c.fadeOut = 0;
  }
  if ('animIn' in right && 'animIn' in c) {
    right.animIn = { ...right.animIn, preset: 'none' };
    c.animOut = { ...c.animOut, preset: 'none' };
    c.transitionOut = undefined;
  }
  if (right.type === 'caption' && c.type === 'caption') {
    // Each half keeps the words spoken in it (by timing when known, else in proportion to time).
    if (c.words?.length) {
      const words = c.words;
      c.words = words.filter((w) => w.start < offset);
      right.words = words.filter((w) => w.start >= offset).map((w) => ({ ...w, start: w.start - offset, end: w.end - offset }));
      c.text = c.words.map((w) => w.text).join(' ').trim() || c.text;
      right.text = right.words.map((w) => w.text).join(' ').trim() || right.text;
    } else {
      const tokens = c.text.split(/\s+/).filter(Boolean);
      if (tokens.length > 1) {
        const k = Math.min(tokens.length - 1, Math.max(1, Math.round((tokens.length * offset) / (offset + right.duration))));
        c.text = tokens.slice(0, k).join(' ');
        right.text = tokens.slice(k).join(' ');
      }
    }
    c.name = c.text.slice(0, 40);
    right.name = right.text.slice(0, 40);
  }
  p.clips[right.id] = right;
  return right.id;
}

export interface TrimOptions {
  /** Allow extending over neighbours (ripple edits move them out of the way themselves). */
  ignoreNeighbors?: boolean;
}

/** End of the closest clip before `c` on its track (0 if none). */
function prevNeighborEnd(p: Project, c: Clip): number {
  let end = 0;
  for (const o of Object.values(p.clips)) {
    if (o.id === c.id || o.trackId !== c.trackId) continue;
    const e = clipEnd(o);
    if (e <= c.start + EPS && e > end) end = e;
  }
  return end;
}

/** Start of the closest clip after `c` on its track (Infinity if none). */
function nextNeighborStart(p: Project, c: Clip): number {
  let start = Infinity;
  const end = clipEnd(c);
  for (const o of Object.values(p.clips)) {
    if (o.id === c.id || o.trackId !== c.trackId) continue;
    if (o.start >= end - EPS && o.start < start) start = o.start;
  }
  return start;
}

/** Trim the head of a clip so it starts at newStart (end stays fixed). */
export function trimStart(p: Project, clipId: ID, newStart: number, opts: TrimOptions = {}): void {
  const c = p.clips[clipId];
  if (!c) return;
  newStart = q(p, newStart);
  const end = clipEnd(c);
  const md = minDuration(p);
  const earliest = c.start - maxHeadExtension(c);
  newStart = Math.max(newStart, earliest, 0);
  if (!opts.ignoreNeighbors) newStart = Math.max(newStart, prevNeighborEnd(p, c));
  newStart = Math.min(newStart, end - md);
  // Re-quantize after clamping to source bounds (keeps us on the grid where possible).
  const delta = newStart - c.start;
  if (Math.abs(delta) < EPS) return;
  c.start = newStart;
  c.duration = end - newStart;
  if (hasSourceTiming(c) && !(c.type === 'video' && c.freeze)) {
    c.sourceIn = Math.max(0, c.sourceIn + delta * c.speed);
  }
  shiftKeyframes(c.keyframes, -delta);
  if (c.type === 'caption' && c.words) {
    c.words = c.words.map((w) => ({ ...w, start: w.start - delta, end: w.end - delta })).filter((w) => w.end > 0);
  }
}

/** Trim the tail of a clip so it ends at newEnd. */
export function trimEnd(p: Project, clipId: ID, newEnd: number, opts: TrimOptions = {}): void {
  const c = p.clips[clipId];
  if (!c) return;
  newEnd = q(p, newEnd);
  if (!opts.ignoreNeighbors) newEnd = Math.min(newEnd, nextNeighborStart(p, c));
  const md = minDuration(p);
  let dur = newEnd - c.start;
  dur = Math.max(md, Math.min(dur, maxDurationFor(p, c)));
  c.duration = dur;
}

/**
 * Remove everything on a track inside [start, end), except the given clips
 * (overwrite edit). Clips straddling the range are trimmed or split.
 */
export function clearRange(p: Project, trackId: ID, start: number, end: number, except: Set<ID> = new Set()): void {
  if (end - start < EPS) return;
  for (const c of clipsOnTrack(p, trackId)) {
    if (except.has(c.id)) continue;
    const cs = c.start;
    const ce = clipEnd(c);
    if (ce <= start + EPS || cs >= end - EPS) continue;
    if (cs >= start - EPS && ce <= end + EPS) {
      delete p.clips[c.id];
    } else if (cs < start && ce > end) {
      // Keep both outer pieces: split off the tail, then trim the head piece.
      splitClip(p, c.id, end);
      trimEnd(p, c.id, start);
    } else if (cs < start) {
      trimEnd(p, c.id, start);
    } else {
      trimStart(p, c.id, end);
    }
  }
}

/** Shift every clip on a track that starts at/after `from` by dt. */
export function shiftTrackFrom(p: Project, trackId: ID, from: number, dt: number, except: Set<ID> = new Set()): void {
  for (const c of Object.values(p.clips)) {
    if (c.trackId !== trackId || except.has(c.id)) continue;
    if (c.start >= from - EPS) c.start = q(p, Math.max(0, c.start + dt));
  }
}

export type PlaceMode = 'overwrite' | 'insert';

/**
 * Place (already-inserted or moved) clips: makes room on their tracks
 * according to `mode`.
 */
export function makeRoomFor(p: Project, clipIds: ID[], mode: PlaceMode): void {
  const moving = new Set(clipIds);
  if (mode === 'insert') {
    // Group by track; split straddling clips at the insertion point and push later clips right.
    const byTrack = new Map<ID, Clip[]>();
    for (const id of clipIds) {
      const c = p.clips[id];
      if (!c) continue;
      const arr = byTrack.get(c.trackId) ?? [];
      arr.push(c);
      byTrack.set(c.trackId, arr);
    }
    for (const [trackId, clips] of byTrack) {
      const s = Math.min(...clips.map((c) => c.start));
      const e = Math.max(...clips.map(clipEnd));
      const len = e - s;
      for (const c of clipsOnTrack(p, trackId)) {
        if (moving.has(c.id)) continue;
        if (c.start < s - EPS && clipEnd(c) > s + EPS) splitClip(p, c.id, s);
      }
      shiftTrackFrom(p, trackId, s, len, moving);
    }
  } else {
    for (const id of clipIds) {
      const c = p.clips[id];
      if (!c) continue;
      clearRange(p, c.trackId, c.start, clipEnd(c), moving);
    }
  }
  normalize(p);
}

export interface MoveSpec {
  clipIds: ID[];
  /** Time delta in seconds. */
  dt: number;
  /** Track index delta within the same section (visual / audio). */
  trackDelta: number;
  mode: PlaceMode;
}

/** Index of tracks within the section they belong to. */
function sectionTracks(p: Project, kind: TrackKind): Track[] {
  return p.tracks.filter((t) => (isVisualTrackKind(kind) ? isVisualTrackKind(t.kind) : t.kind === 'audio'));
}

/** Resolve the destination track for a clip moved by trackDelta, or null if invalid. */
export function targetTrackFor(p: Project, c: Clip, trackDelta: number): Track | null {
  const src = trackById(p, c.trackId);
  if (!src) return null;
  if (trackDelta === 0) return src;
  const sect = sectionTracks(p, src.kind);
  const idx = sect.findIndex((t) => t.id === src.id);
  const dest = sect[idx + trackDelta];
  if (!dest || !trackAccepts(dest.kind, c.type) || dest.locked) return null;
  return dest;
}

export function moveClips(p: Project, spec: MoveSpec): void {
  const clips = spec.clipIds.map((id) => p.clips[id]).filter(Boolean) as Clip[];
  if (clips.length === 0) return;
  // Never move anything before t=0.
  const minStart = Math.min(...clips.map((c) => c.start));
  const dt = Math.max(spec.dt, -minStart);
  // A track delta is only applied if every clip has a valid destination.
  const dests = clips.map((c) => targetTrackFor(p, c, spec.trackDelta));
  const useDelta = dests.every((d) => d !== null);
  clips.forEach((c, i) => {
    c.start = q(p, c.start + dt);
    if (useDelta) c.trackId = dests[i]!.id;
  });
  makeRoomFor(p, spec.clipIds, spec.mode);
}

export function deleteClips(p: Project, ids: ID[], ripple: boolean): void {
  const clips = ids.map((id) => p.clips[id]).filter(Boolean) as Clip[];
  // Process right-to-left so ripple shifts don't affect pending deletions.
  clips.sort((a, b) => b.start - a.start);
  for (const c of clips) {
    delete p.clips[c.id];
    if (ripple) {
      const end = clipEnd(c);
      const track = trackById(p, c.trackId);
      if (track?.locked) continue;
      // Only close the gap if nothing else now occupies [c.start, end).
      const occupied = clipsOnTrack(p, c.trackId).some((o) => o.start < end - EPS && clipEnd(o) > c.start + EPS);
      if (!occupied) shiftTrackFrom(p, c.trackId, end, -c.duration);
    }
  }
  normalize(p);
}

/** Close the empty gap on a track that contains time t. Returns true if a gap was closed. */
export function closeGapAt(p: Project, trackId: ID, t: number): boolean {
  const clips = clipsOnTrack(p, trackId);
  let gapStart = 0;
  for (const c of clips) {
    if (c.start > t + EPS) {
      if (t >= gapStart - EPS) {
        const len = c.start - gapStart;
        if (len > EPS) {
          shiftTrackFrom(p, trackId, c.start, -len);
          normalize(p);
          return true;
        }
      }
      return false;
    }
    gapStart = Math.max(gapStart, clipEnd(c));
  }
  return false;
}

/** Split all (or the given) clips under time t on unlocked tracks. Returns new right-piece ids. */
export function splitAt(p: Project, t: number, onlyIds?: ID[]): ID[] {
  const created: ID[] = [];
  const candidates = onlyIds && onlyIds.length > 0 ? onlyIds.map((id) => p.clips[id]).filter(Boolean) : Object.values(p.clips);
  for (const c of candidates as Clip[]) {
    const track = trackById(p, c.trackId);
    if (!track || track.locked) continue;
    if (c.start < t - EPS && clipEnd(c) > t + EPS) {
      const id = splitClip(p, c.id, t);
      if (id) created.push(id);
    }
  }
  normalize(p);
  return created;
}

/** Change playback speed, keeping the start fixed. Later clips on the track ripple if needed. */
export function setSpeed(p: Project, clipId: ID, speed: number): void {
  const c = p.clips[clipId];
  if (!c || !hasSourceTiming(c)) return;
  speed = Math.min(16, Math.max(0.1, speed));
  const sourceLen = c.duration * c.speed;
  const oldEnd = clipEnd(c);
  c.speed = speed;
  let dur = q(p, sourceLen / speed);
  dur = Math.max(minDuration(p), Math.min(dur, maxDurationFor(p, c)));
  c.duration = dur;
  const newEnd = clipEnd(c);
  if (newEnd > oldEnd + EPS) {
    // Push following clips on this track if they'd now overlap.
    const next = clipsOnTrack(p, c.trackId).find((o) => o.id !== c.id && o.start >= oldEnd - EPS);
    if (next && next.start < newEnd - EPS) shiftTrackFrom(p, c.trackId, oldEnd, newEnd - next.start, new Set([c.id]));
  }
  // Keyframes are in timeline time; rescale so they stay attached to the same content.
  const k = (oldEnd - c.start) > 0 ? dur / (oldEnd - c.start) : 1;
  for (const list of Object.values(c.keyframes)) for (const kf of list) kf.t *= k;
  normalize(p);
}

/** Find an audio track with free space for [start, end), or create one. */
export function findOrCreateTrack(p: Project, kind: TrackKind, start: number, end: number, prefer?: ID): Track {
  const candidates = p.tracks.filter((t) => t.kind === kind && !t.locked);
  const ordered = prefer ? [...candidates.filter((t) => t.id === prefer), ...candidates.filter((t) => t.id !== prefer)] : candidates;
  for (const t of ordered) {
    const free = clipsOnTrack(p, t.id).every((c) => clipEnd(c) <= start + EPS || c.start >= end - EPS);
    if (free) return t;
  }
  return addTrack(p, kind);
}

/** Add a track in its section (visual tracks are added on top, audio tracks at the bottom). */
export function addTrack(p: Project, kind: TrackKind, index?: number): Track {
  const t = createTrack(kind, nextTrackName(p, kind));
  if (index !== undefined) {
    p.tracks.splice(index, 0, t);
  } else if (kind === 'audio') {
    p.tracks.push(t);
  } else if (kind === 'caption') {
    p.tracks.unshift(t);
  } else {
    // Above existing video tracks but below caption tracks.
    const firstVideo = p.tracks.findIndex((x) => x.kind === 'video');
    const firstNonCaption = p.tracks.findIndex((x) => x.kind !== 'caption');
    const at = firstVideo >= 0 ? firstVideo : firstNonCaption >= 0 ? firstNonCaption : p.tracks.length;
    p.tracks.splice(at, 0, t);
  }
  return t;
}

export function removeTrack(p: Project, trackId: ID): void {
  for (const c of Object.values(p.clips)) if (c.trackId === trackId) delete p.clips[c.id];
  p.tracks = p.tracks.filter((t) => t.id !== trackId);
}

/** Move a track up/down within its section. */
export function reorderTrack(p: Project, trackId: ID, toIndex: number): void {
  const from = p.tracks.findIndex((t) => t.id === trackId);
  if (from < 0) return;
  const [t] = p.tracks.splice(from, 1);
  toIndex = Math.max(0, Math.min(p.tracks.length, toIndex));
  p.tracks.splice(toIndex, 0, t);
  enforceTrackSections(p);
}

/** Keep all visual tracks above all audio tracks. Stable within each group. */
export function enforceTrackSections(p: Project): void {
  const visual = p.tracks.filter((t) => isVisualTrackKind(t.kind));
  const audio = p.tracks.filter((t) => t.kind === 'audio');
  p.tracks = [...visual, ...audio];
}

/** Move a video clip's audio to its own clip on an audio track and mute the original. */
export function detachAudio(p: Project, clipId: ID): ID | null {
  const c = p.clips[clipId];
  // A muted video clip has no audio to detach (its sound was already detached or turned off).
  if (!c || c.type !== 'video' || c.muted) return null;
  const asset = p.assets[c.assetId];
  if (!asset?.audio) return null;
  const track = findOrCreateTrack(p, 'audio', c.start, clipEnd(c));
  const a: AudioClip = createAudioClip(asset, { trackId: track.id, start: c.start, duration: c.duration });
  a.sourceIn = c.sourceIn;
  a.speed = c.speed;
  a.preservePitch = c.preservePitch;
  a.volume = c.volume;
  a.pan = c.pan;
  a.fadeIn = c.fadeIn;
  a.fadeOut = c.fadeOut;
  a.denoise = c.denoise;
  if (c.keyframes.volume) a.keyframes.volume = deepClone(c.keyframes.volume);
  if (c.keyframes.pan) a.keyframes.pan = deepClone(c.keyframes.pan);
  p.clips[a.id] = a;
  (c as VideoClip).muted = true;
  return a.id;
}

/** Adjacent following clip on the same track (touching within half a frame). */
export function nextAdjacent(p: Project, c: Clip): Clip | null {
  const end = clipEnd(c);
  const tol = 0.5 / p.settings.fps;
  for (const o of Object.values(p.clips)) {
    if (o.id !== c.id && o.trackId === c.trackId && Math.abs(o.start - end) <= tol) return o;
  }
  return null;
}

export function prevAdjacent(p: Project, c: Clip): Clip | null {
  const tol = 0.5 / p.settings.fps;
  for (const o of Object.values(p.clips)) {
    if (o.id !== c.id && o.trackId === c.trackId && Math.abs(clipEnd(o) - c.start) <= tol) return o;
  }
  return null;
}

/** Longest transition allowed between two adjacent clips. */
export function maxTransitionDuration(a: Clip, b: Clip): number {
  return Math.max(0, Math.min(a.duration, b.duration));
}

/**
 * Repair invariants after edits: drop transitions without a partner, clamp
 * durations, clamp fades, remove clips that reference missing tracks.
 */
export function normalize(p: Project): void {
  const trackIds = new Set(p.tracks.map((t) => t.id));
  const md = minDuration(p);
  for (const c of Object.values(p.clips)) {
    if (!trackIds.has(c.trackId)) {
      delete p.clips[c.id];
      continue;
    }
    if (c.duration < md - EPS) c.duration = md;
    if (c.start < 0) c.start = 0;
    if (hasSourceTiming(c)) {
      const max = c.duration;
      if (c.fadeIn > max) c.fadeIn = max;
      if (c.fadeOut > max) c.fadeOut = max;
    }
  }
  for (const c of Object.values(p.clips)) {
    if (!('transitionOut' in c) || !c.transitionOut) continue;
    const next = nextAdjacent(p, c);
    if (!next || !isVisualClip(next)) {
      c.transitionOut = undefined;
      continue;
    }
    const max = maxTransitionDuration(c, next);
    if (max < 2 / p.settings.fps) c.transitionOut = undefined;
    else if (c.transitionOut.duration > max) c.transitionOut.duration = max;
  }
}

/** Duplicate clips, placing copies right after the latest selected clip end on the same tracks. */
export function duplicateClips(p: Project, ids: ID[]): ID[] {
  const clips = ids.map((id) => p.clips[id]).filter(Boolean) as Clip[];
  if (clips.length === 0) return [];
  const s = Math.min(...clips.map((c) => c.start));
  const e = Math.max(...clips.map(clipEnd));
  const out: ID[] = [];
  for (const c of clips) {
    const copy = deepClone(c);
    copy.id = uid('clp');
    copy.start = q(p, c.start + (e - s));
    p.clips[copy.id] = copy;
    out.push(copy.id);
  }
  // The copy goes right after the selection and pushes what follows later (never over it).
  makeRoomFor(p, out, 'insert');
  return out;
}

/** Paste serialized clips at time t, keeping relative offsets and tracks when possible. */
export function pasteClips(p: Project, clips: Clip[], t: number): ID[] {
  if (clips.length === 0) return [];
  const s = Math.min(...clips.map((c) => c.start));
  const out: ID[] = [];
  for (const src of clips) {
    const c = deepClone(src);
    c.id = uid('clp');
    c.start = q(p, t + (src.start - s));
    let track = trackById(p, c.trackId);
    if (!track || !trackAccepts(track.kind, c.type) || track.locked) {
      const kind: TrackKind = c.type === 'audio' ? 'audio' : c.type === 'caption' ? 'caption' : 'video';
      track = findOrCreateTrack(p, kind, c.start, c.start + c.duration);
    }
    c.trackId = track.id;
    if ('assetId' in c && !p.assets[c.assetId]) continue;
    p.clips[c.id] = c;
    out.push(c.id);
  }
  makeRoomFor(p, out, 'overwrite');
  return out;
}

/** Remove tracks that have no clips, keeping at least one video and one audio track. */
export function removeEmptyTracks(p: Project): void {
  const used = new Set(Object.values(p.clips).map((c) => c.trackId));
  const keep: Track[] = [];
  let videoKept = false;
  let audioKept = false;
  for (const t of p.tracks) {
    if (used.has(t.id)) {
      keep.push(t);
      if (t.kind === 'video') videoKept = true;
      if (t.kind === 'audio') audioKept = true;
    }
  }
  if (!videoKept) {
    const t = p.tracks.find((x) => x.kind === 'video');
    if (t) keep.unshift(t);
  }
  if (!audioKept) {
    const t = p.tracks.find((x) => x.kind === 'audio');
    if (t) keep.push(t);
  }
  p.tracks = p.tracks.filter((t) => keep.includes(t));
}

/**
 * Frame-aligned spans for timed text (captions): start and end are snapped to
 * frames separately (so rounding never makes neighbours overlap), and each cue
 * ends where the next begins at the latest.
 */
export function frameCues<T extends { start: number; end: number }>(p: Project, cues: T[]): (T & { qStart: number; qEnd: number })[] {
  const f = 1 / p.settings.fps;
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  return sorted.map((c, i) => {
    const s = q(p, c.start);
    const next = sorted[i + 1];
    const e = q(p, next ? Math.min(c.end, next.start) : c.end);
    return { ...c, qStart: s, qEnd: Math.max(e, s + f) };
  });
}

/** Remove the clips on `trackId` that overlap [start, end). */
export function clearTrackRange(p: Project, trackId: ID, start: number, end: number): void {
  for (const c of clipsOnTrack(p, trackId)) if (c.start < end - EPS && clipEnd(c) > start + EPS) delete p.clips[c.id];
}

/**
 * Cut the time ranges out of the given tracks and close the gaps, moving the
 * tracks (and markers) together so everything after a cut stays in sync.
 * Clips spanning a range are split around it.
 */
export function removeTimeRanges(p: Project, ranges: { start: number; end: number }[], trackIds: ID[]): void {
  for (const r of [...ranges].sort((a, b) => b.start - a.start)) {
    const len = r.end - r.start;
    if (len <= EPS) continue;
    for (const tid of trackIds) {
      for (const c of clipsOnTrack(p, tid)) {
        if (clipEnd(c) <= r.start + EPS || c.start >= r.end - EPS) continue;
        let id: ID | null = c.id;
        if (clipEnd(c) > r.end + EPS) splitClip(p, id, r.end);
        if (p.clips[id].start < r.start - EPS) id = splitClip(p, id, r.start);
        if (id) delete p.clips[id];
      }
      shiftTrackFrom(p, tid, r.end - EPS, -len);
    }
    for (const m of p.markers) {
      if (m.t >= r.end - EPS) m.t = q(p, m.t - len);
      else if (m.t > r.start) m.t = q(p, r.start);
    }
  }
}
