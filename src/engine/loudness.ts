import type { Project } from '@/core/types';
import { LoudnessMeter } from './audioDsp';
import type { AudioMixer } from './audioMixer';

/** Common delivery targets (integrated loudness, LUFS). */
export const LOUDNESS_TARGETS = [
  { value: -14, label: '−14 LUFS', tip: 'YouTube, Spotify, Instagram, TikTok' },
  { value: -16, label: '−16 LUFS', tip: 'Podcasts (Apple), voice-led video' },
  { value: -23, label: '−23 LUFS', tip: 'Broadcast (EBU R128)' },
] as const;

/** Never raise quiet material by more than this (it would mostly lift noise). */
export const MAX_LOUDNESS_GAIN_DB = 20;

/** Peak ceiling used when normalizing: -1 dBFS (sample peak, with a little room for the encoder). */
export const LOUDNESS_CEILING = Math.pow(10, -1.5 / 20);

/**
 * Integrated loudness (BS.1770) and sample peak of the mix over [start, end),
 * rendered with the same mixer the preview and export use.
 */
export async function measureMix(
  mixer: AudioMixer,
  p: Project,
  start: number,
  end: number,
  opts: { onProgress?: (fraction: number) => void; cancelled?: () => boolean } = {},
): Promise<{ lufs: number; peak: number }> {
  const sr = mixer.sampleRate;
  const block = sr;
  const meter = new LoudnessMeter(sr);
  const L = new Float32Array(block);
  const R = new Float32Array(block);
  const total = Math.max(0, Math.round((end - start) * sr));
  for (let done = 0, i = 0; done < total; done += block, i++) {
    if (opts.cancelled?.()) throw new Error('cancelled');
    const n = Math.min(block, total - done);
    const t = start + done / sr;
    await mixer.prepare(p, t, n);
    mixer.mix(p, t, n, L, R);
    meter.push(L, R, n);
    opts.onProgress?.((done + n) / total);
    // Stay responsive on the main thread.
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));
  }
  return { lufs: meter.integrated(), peak: meter.peak };
}

/** Gain (dB) that brings `measured` to `target`, capped; 0 for silence. */
export function loudnessGainDb(measured: number, target: number): number {
  if (!Number.isFinite(measured)) return 0;
  return Math.min(MAX_LOUDNESS_GAIN_DB, target - measured);
}
