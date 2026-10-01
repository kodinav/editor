import type { Asset } from '@/core/types';
import { media } from '@/media/registry';
import { DIRS, getFile } from '@/storage/opfs';
import type { DenoiseMessage, DenoiseRequest } from '@/workers/denoise.worker';
import { editor, toast } from './store';

export type NoiseLevel = 'off' | 'light' | 'medium' | 'strong';
type Level = Exclude<NoiseLevel, 'off'>;

let seq = 0;

/** Make (or reuse) the asset's noise-reduced audio and switch the clip to it. */
export async function setNoiseReduction(clipId: string, level: NoiseLevel, onProgress: (f: number) => void): Promise<void> {
  const clip = editor().project.clips[clipId];
  if (!clip || (clip.type !== 'video' && clip.type !== 'audio')) return;
  if (level === 'off') {
    editor().commit('Noise reduction off', (d) => {
      const c = d.clips[clipId];
      if (c && (c.type === 'video' || c.type === 'audio')) c.denoise = false;
    });
    return;
  }
  const asset = editor().project.assets[clip.assetId];
  if (!asset?.audio) return;
  if (asset.audio.denoise !== level || !media.getPcm(asset.id, 'nr')) {
    if (!media.getPcmBlob(asset.id)) {
      toast({ kind: 'info', message: 'The audio is still being prepared. Try again in a moment.' });
      return;
    }
    try {
      await buildVariant(asset, level, onProgress);
    } catch (e) {
      toast({ kind: 'error', message: 'Noise reduction failed.', detail: (e as Error).message });
      return;
    }
  }
  editor().commit('Noise reduction', (d) => {
    // Every clip of this asset shares the cleaned audio; enable it on this one.
    const c = d.clips[clipId];
    if (c && (c.type === 'video' || c.type === 'audio')) c.denoise = true;
  });
}

/**
 * Rebuild cleaned audio the project relies on but storage no longer has
 * (cleared site data), or that came from a file since relinked (`rebuild`),
 * so playback and export don't quietly use the wrong audio.
 */
export async function restoreNoiseReduction(assetId: string, rebuild = false): Promise<void> {
  const asset = editor().project.assets[assetId];
  const level = asset?.audio?.denoise;
  if (!level || (!rebuild && media.getPcm(assetId, 'nr')) || !media.getPcmBlob(assetId)) return;
  media.setProgress(assetId, { stage: 'audio', value: 0 });
  try {
    await buildVariant(asset, level, (value) => media.setProgress(assetId, { stage: 'audio', value }));
  } catch (e) {
    toast({ kind: 'error', message: `Noise reduction for “${asset.name}” couldn’t be restored.`, detail: (e as Error).message });
  } finally {
    media.setProgress(assetId, null);
  }
}

/** Run the noise-reduction worker over an asset's audio and register the result. */
async function buildVariant(asset: Asset, level: Level, onProgress: (f: number) => void): Promise<void> {
  const pcm = media.getPcmBlob(asset.id);
  if (!asset.audio || !pcm) throw new Error('The audio is still being prepared.');
  const channels = asset.audio.channels >= 2 ? 2 : 1;
  // The worker rewrites the variant's file; stop reading the old one first.
  media.dropPcmVariant(asset.id, 'nr');
  const worker = new Worker(new URL('../workers/denoise.worker.ts', import.meta.url), { type: 'module', name: 'denoise' });
  const id = ++seq;
  try {
    const buffer = await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<DenoiseMessage>) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === 'progress') onProgress(m.value);
        else if (m.type === 'done') resolve(m.buffer);
        else reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'Noise reduction crashed.'));
      const req: DenoiseRequest = { type: 'denoise', id, assetId: asset.id, pcm, channels, preset: level };
      worker.postMessage(req);
    });
    const data = buffer ?? (await getFile(DIRS.pcm, asset.id + '.nr.pcm'));
    if (!data) throw new Error('The cleaned audio could not be saved.');
    editor().silent((d) => {
      const a = d.assets[asset.id];
      if (a?.audio) a.audio.denoise = level;
    });
    media.setPcmVariant(editor().project.assets[asset.id], 'nr', data);
  } finally {
    worker.terminate();
  }
}
