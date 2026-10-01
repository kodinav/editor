import { evalProp } from './keyframes';
import { clipEnd } from './project';
import { nextAdjacent, prevAdjacent } from './ops';
import type { AudibleClip, Project, Track } from './types';
import { isVisualClip } from './types';

/**
 * Audio planning: which clips are audible and with what gain at a given time.
 * Shared by the realtime preview mixer and the export mixer so both produce
 * identical audio.
 */

export interface AudioSegment {
  clip: AudibleClip;
  track: Track;
  assetId: string;
  start: number;
  end: number;
}

export function audibleSegments(p: Project, from: number, to: number): AudioSegment[] {
  const tracks = new Map(p.tracks.map((t) => [t.id, t]));
  const out: AudioSegment[] = [];
  for (const c of Object.values(p.clips)) {
    if (c.type !== 'video' && c.type !== 'audio') continue;
    if (c.disabled || c.muted) continue;
    if (c.type === 'video' && c.freeze) continue;
    const track = tracks.get(c.trackId);
    if (!track || track.muted) continue;
    // Hidden video tracks are also silent: hiding a track takes it out of the mix entirely.
    if (track.kind === 'video' && track.hidden) continue;
    const asset = p.assets[c.assetId];
    if (!asset?.audio) continue;
    const end = clipEnd(c);
    if (end <= from || c.start >= to) continue;
    out.push({ clip: c, track, assetId: c.assetId, start: c.start, end });
  }
  return out;
}

function equalPowerIn(p: number): number {
  return Math.sin((Math.max(0, Math.min(1, p)) * Math.PI) / 2);
}

/**
 * Linear gain of a clip at absolute timeline time t (excluding pan),
 * including volume keyframes, fades, transition crossfades, track and master volume.
 */
export function clipGainAt(p: Project, seg: AudioSegment, t: number): number {
  const c = seg.clip;
  const lt = t - c.start;
  if (lt < 0 || t >= seg.end) return 0;
  let g = evalProp(c, 'volume', lt);
  if (c.fadeIn > 0 && lt < c.fadeIn) g *= lt / c.fadeIn;
  const rem = c.duration - lt;
  if (c.fadeOut > 0 && rem < c.fadeOut) g *= Math.max(0, rem) / c.fadeOut;
  // Video transitions also crossfade the clips' audio around the cut.
  if (c.type === 'video') {
    if (c.transitionOut) {
      const next = nextAdjacent(p, c);
      if (next && isVisualClip(next)) {
        const half = c.transitionOut.duration / 2;
        if (rem < half) g *= equalPowerIn(rem / half);
      }
    }
    const prev = prevAdjacent(p, c);
    if (prev && isVisualClip(prev) && prev.transitionOut) {
      const half = prev.transitionOut.duration / 2;
      if (lt < half) g *= equalPowerIn(lt / half);
    }
  }
  return g * seg.track.volume * p.masterVolume;
}

export function clipPanAt(seg: AudioSegment, t: number): number {
  return Math.max(-1, Math.min(1, evalProp(seg.clip, 'pan', t - seg.clip.start)));
}

/** Map a timeline time to source time for an audible clip. */
export function audioSourceTime(seg: AudioSegment, t: number): number {
  return seg.clip.sourceIn + (t - seg.clip.start) * seg.clip.speed;
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return g <= 0 ? -Infinity : 20 * Math.log10(g);
}
