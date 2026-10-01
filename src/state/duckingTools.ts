import { duckKeyframes, mergeActivity, type DuckOptions } from '@/core/ducking';
import { uid } from '@/core/ids';
import { evalProp } from '@/core/keyframes';
import { clipEnd } from '@/core/project';
import { windowRms, type Region } from '@/core/silence';
import type { AudibleClip } from '@/core/types';
import { media } from '@/media/registry';
import { editor, toast } from './store';

/**
 * Auto-ducking: find where other clips contain speech (by level), then write
 * volume keyframes on the target clip (usually music) that dip under them.
 */

const WIN = 0.05;

async function activityFor(source: AudibleClip, from: number, to: number, thresholdDb: number): Promise<Region[]> {
  const pcm = media.getPcm(source.assetId);
  if (!pcm) return [];
  const a = Math.max(from, source.start);
  const b = Math.min(to, clipEnd(source));
  if (b <= a) return [];
  const sr = pcm.sampleRate;
  const s0 = source.sourceIn + (a - source.start) * source.speed;
  const s1 = source.sourceIn + (b - source.start) * source.speed;
  const f0 = Math.floor(s0 * sr);
  const f1 = Math.ceil(s1 * sr);
  const win = Math.max(1, Math.round(WIN * sr * source.speed));
  const thr = Math.pow(10, thresholdDb / 20);
  const out: Region[] = [];
  const CHUNK = sr * 20;
  for (let f = f0; f < f1; f += CHUNK) {
    const e = Math.min(f1, f + CHUNK);
    await pcm.ensure(f, e);
    const rms = windowRms((x, ch) => pcm.sample(x, ch), pcm.channels, f, e, win);
    for (let i = 0; i < rms.length; i++) {
      if (rms[i] < thr) continue;
      // Window start in timeline seconds.
      const srcT = (f + i * win) / sr;
      const t = source.start + (srcT - source.sourceIn) / source.speed;
      out.push({ start: t, end: t + WIN });
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

export async function duckUnderSpeech(clipId: string, opts: DuckOptions & { thresholdDb: number }): Promise<void> {
  const p = editor().project;
  const target = p.clips[clipId];
  if (!target || (target.type !== 'video' && target.type !== 'audio')) return;
  const tracks = new Map(p.tracks.map((t) => [t.id, t]));
  const from = target.start;
  const to = clipEnd(target);
  const sources = Object.values(p.clips).filter(
    (c): c is AudibleClip =>
      (c.type === 'video' || c.type === 'audio') &&
      c.id !== clipId &&
      !c.muted &&
      !c.disabled &&
      !tracks.get(c.trackId)?.muted &&
      !!p.assets[c.assetId]?.audio &&
      c.start < to &&
      clipEnd(c) > from,
  );
  if (sources.length === 0) {
    toast({ kind: 'info', message: 'Nothing to duck under.', detail: 'Ducking lowers this clip wherever other clips (like a voiceover) have sound at the same time.' });
    return;
  }
  const raw: Region[] = [];
  for (const s of sources) raw.push(...(await activityFor(s, from, to, opts.thresholdDb)));
  const regions = mergeActivity(raw, 0.45, 0.25).map((r) => ({ start: r.start - from, end: r.end - from }));
  if (regions.length === 0) {
    toast({ kind: 'info', message: 'No speech found under this clip.', detail: 'Try a lower sensitivity threshold.' });
    return;
  }
  const hadKeys = (target.keyframes.volume?.length ?? 0) > 0;
  const base = evalProp(target, 'volume', 0);
  editor().commit('Duck under speech', (d) => {
    const c = d.clips[clipId];
    if (!c) return;
    c.keyframes.volume = duckKeyframes(regions, c.duration, base, opts, () => uid('kf'));
  });
  toast({
    kind: 'success',
    message: `Ducked under ${regions.length} passage${regions.length === 1 ? '' : 's'} of speech.`,
    detail: `${hadKeys ? 'Replaced the previous volume keyframes. ' : ''}The dips are regular volume keyframes — adjust them in the inspector or undo.`,
  });
}
