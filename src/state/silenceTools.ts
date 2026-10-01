import { shiftTrackFrom, splitClip, normalize } from '@/core/ops';
import { clipEnd } from '@/core/project';
import { silentRegions, windowRms, type Region, type SilenceOptions } from '@/core/silence';
import { media } from '@/media/registry';
import { editor, toast } from './store';

/**
 * "Remove silences": find pauses in a clip's audio and cut them out,
 * closing the gaps. Detection runs on the conformed PCM in bounded chunks.
 */

const WINDOW = 0.02;
const CHUNK_SECONDS = 20;


/** Silent regions in timeline time for a video/audio clip. */
export async function findSilences(clipId: string, opts: SilenceOptions, onProgress?: (f: number) => void): Promise<Region[]> {
  const c = editor().project.clips[clipId];
  if (!c || (c.type !== 'video' && c.type !== 'audio')) return [];
  const pcm = media.getPcm(c.assetId);
  if (!pcm) throw new Error('The audio for this clip is still being prepared.');
  const sr = pcm.sampleRate;
  const s0 = c.sourceIn;
  const s1 = c.sourceIn + c.duration * c.speed;
  const win = Math.max(1, Math.round(WINDOW * sr));
  const f0 = Math.floor(s0 * sr);
  const f1 = Math.ceil(s1 * sr);
  const totalWindows = Math.max(0, Math.ceil((f1 - f0) / win));
  const perChunk = Math.max(1, Math.round((CHUNK_SECONDS * sr) / win));
  const rms = new Float32Array(totalWindows);
  for (let w = 0; w < totalWindows; w += perChunk) {
    const a = f0 + w * win;
    const b = Math.min(f1, a + perChunk * win);
    await pcm.ensure(a, b);
    rms.set(windowRms((f, ch) => pcm.sample(f, ch), pcm.channels, a, b, win), w);
    onProgress?.(Math.min(1, (w + perChunk) / totalWindows));
    // Yield so the UI stays responsive on long clips.
    await new Promise((r) => setTimeout(r, 0));
  }
  const regions = silentRegions(rms, s0, win / sr, opts);
  // Source time -> timeline time, clamped to the clip.
  return regions
    .map((r) => ({ start: c.start + (r.start - s0) / c.speed, end: c.start + (r.end - s0) / c.speed }))
    .map((r) => ({ start: Math.max(c.start, r.start), end: Math.min(clipEnd(c), r.end) }))
    .filter((r) => r.end - r.start > 1 / editor().project.settings.fps);
}

/** Cut the regions out of the clip and close the gaps on its track. */
export function removeRegions(clipId: string, regions: Region[]): number {
  const c0 = editor().project.clips[clipId];
  if (!c0 || regions.length === 0) return 0;
  let removed = 0;
  editor().commit('Remove silences', (d) => {
    const trackId = c0.trackId;
    // Right to left, so earlier regions keep their positions; the original id always
    // refers to the left-most piece.
    for (const r of [...regions].sort((a, b) => b.start - a.start)) {
      const c = d.clips[clipId];
      if (!c) break;
      const end = clipEnd(c);
      const s = Math.max(c.start, r.start);
      const e = Math.min(end, r.end);
      if (e - s <= 0) continue;
      let middleId: string | null = clipId;
      if (e < end - 1e-6) splitClip(d, clipId, e);
      if (s > c.start + 1e-6) middleId = splitClip(d, clipId, s);
      if (!middleId || !d.clips[middleId]) continue;
      const len = d.clips[middleId].duration;
      delete d.clips[middleId];
      shiftTrackFrom(d, trackId, e - 1e-6, -len);
      removed++;
    }
    normalize(d);
  });
  return removed;
}

export async function removeSilencesFromClip(clipId: string, opts: SilenceOptions) {
  try {
    const regions = await findSilences(clipId, opts);
    if (regions.length === 0) {
      toast({ kind: 'info', message: 'No pauses found with these settings.', detail: 'Try a higher threshold or a shorter minimum length.' });
      return;
    }
    const total = regions.reduce((n, r) => n + r.end - r.start, 0);
    const n = removeRegions(clipId, regions);
    toast({ kind: 'success', message: `Removed ${n} pause${n === 1 ? '' : 's'} (${total.toFixed(1)} s).`, detail: 'Undo restores them.' });
  } catch (e) {
    toast({ kind: 'error', message: 'Could not analyze the audio.', detail: (e as Error).message });
  }
}
