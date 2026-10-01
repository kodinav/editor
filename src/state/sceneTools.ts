import { splitClip } from '@/core/ops';
import { clipEnd } from '@/core/project';
import { media } from '@/media/registry';
import type { ScenesMessage, ScenesRequest } from '@/workers/scenes.worker';
import { editor, toast } from './store';

/** Detect shot changes inside a video clip and split it at each one. */

let seq = 0;

export async function detectScenes(clipId: string, sensitivity: number, onProgress: (f: number) => void): Promise<number[]> {
  const c = editor().project.clips[clipId];
  if (!c || c.type !== 'video') return [];
  const file = media.getFile(c.assetId);
  if (!file) throw new Error('The media for this clip is offline.');
  const worker = new Worker(new URL('../workers/scenes.worker.ts', import.meta.url), { type: 'module', name: 'scenes' });
  const id = ++seq;
  const srcEnd = c.sourceIn + c.duration * c.speed;
  try {
    const cuts = await new Promise<number[]>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent<ScenesMessage>) => {
        const m = e.data;
        if (m.id !== id) return;
        if (m.type === 'progress') onProgress(m.value);
        else if (m.type === 'result') resolve(m.cuts);
        else reject(new Error(m.message));
      };
      worker.onerror = (e) => reject(new Error(e.message || 'Scene detection crashed.'));
      const req: ScenesRequest = { type: 'detect', id, file, start: c.sourceIn, end: srcEnd, sensitivity };
      worker.postMessage(req);
    });
    // Source time -> timeline time.
    return cuts.map((s) => c.start + (s - c.sourceIn) / c.speed).filter((t) => t > c.start + 1e-3 && t < clipEnd(c) - 1e-3);
  } finally {
    worker.terminate();
  }
}

export async function splitAtScenes(clipId: string, sensitivity: number, onProgress: (f: number) => void): Promise<number> {
  try {
    const times = await detectScenes(clipId, sensitivity, onProgress);
    if (times.length === 0) {
      toast({ kind: 'info', message: 'No scene changes found.', detail: 'Try a higher sensitivity.' });
      return 0;
    }
    let made = 0;
    const created: string[] = [];
    editor().commit('Split at scenes', (d) => {
      // Right to left so the original id keeps the first piece.
      for (const t of [...times].sort((a, b) => b - a)) {
        const r = splitClip(d, clipId, t);
        if (r) {
          made++;
          created.push(r);
        }
      }
    });
    editor().select([clipId, ...created]);
    toast({ kind: 'success', message: `Split into ${made + 1} scenes.`, detail: 'Each shot is now its own clip — rearrange, trim or delete them.' });
    return made;
  } catch (e) {
    toast({ kind: 'error', message: 'Scene detection failed.', detail: (e as Error).message });
    return 0;
  }
}
