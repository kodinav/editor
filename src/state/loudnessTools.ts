import { clipEnd } from '@/core/project';
import type { AudibleClip, Project } from '@/core/types';
import { AudioMixer } from '@/engine/audioMixer';
import { loudnessGainDb, measureMix } from '@/engine/loudness';
import { media } from '@/media/registry';
import { editor, toast } from './store';

/** The largest clip volume the editor allows (+24 dB). */
const MAX_VOLUME = 16;

/** Loudness (LUFS) of one clip as it plays — its own volume, effects and noise reduction, nothing else. */
export async function measureClipLoudness(clipId: string): Promise<number> {
  const p = editor().project;
  const c = p.clips[clipId];
  if (!c || (c.type !== 'video' && c.type !== 'audio')) return -Infinity;
  // A project holding just this clip, on a neutral track, so other sound and the master level don't count.
  const solo: Project = structuredClone(p);
  solo.clips = { [c.id]: { ...structuredClone(c), muted: false, disabled: false, fadeIn: 0, fadeOut: 0, transitionOut: undefined } as AudibleClip };
  solo.tracks = solo.tracks.map((t) => (t.id === c.trackId ? { ...t, volume: 1, muted: false, solo: false, hidden: false } : t));
  solo.masterVolume = 1;
  const r = await measureMix(new AudioMixer(media, 48000), solo, c.start, clipEnd(c));
  return r.lufs;
}

/**
 * Set a clip's level so it measures `target` LUFS. Volume keyframes (ducking,
 * swells) are scaled together, so the shape of any automation is kept.
 */
export async function normalizeClipLoudness(clipId: string, target: number): Promise<{ measured: number; gainDb: number } | null> {
  const measured = await measureClipLoudness(clipId);
  if (!Number.isFinite(measured)) {
    toast({ kind: 'warning', message: 'This clip is silent, so there is nothing to normalize.' });
    return null;
  }
  const gainDb = loudnessGainDb(measured, target);
  const k = Math.pow(10, gainDb / 20);
  let capped = false;
  editor().commit('Normalize loudness', (d) => {
    const c = d.clips[clipId] as AudibleClip | undefined;
    if (!c) return;
    const scale = (v: number) => {
      const out = v * k;
      if (out > MAX_VOLUME) capped = true;
      return Math.min(MAX_VOLUME, out);
    };
    c.volume = scale(c.volume);
    for (const kf of c.keyframes.volume ?? []) kf.v = scale(kf.v);
  });
  if (capped) toast({ kind: 'warning', message: 'The clip is very quiet: it was raised as far as the volume goes (+24 dB) and is still below the target.' });
  return { measured, gainDb };
}
