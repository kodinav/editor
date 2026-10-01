import { evaluateFrame } from '@/core/evaluate';
import { formatTimecode } from '@/core/time';
import { Compositor } from '@/engine/compositor';
import { player } from '@/playback/player';
import { editor, toast, usePlayback } from '@/state/store';
import { downloadBlob } from '@/ui/download';

/** Save the frame under the playhead as a full-resolution PNG. */
export async function exportCurrentFrame(): Promise<void> {
  const p = editor().project;
  const t = usePlayback.getState().time;
  const { width, height } = p.settings;
  let comp: Compositor | null = null;
  try {
    const canvas = new OffscreenCanvas(width, height);
    comp = new Compositor(canvas, { preserveDrawingBuffer: true });
    const desc = evaluateFrame(p, t);
    await player.sources.prepare(desc, 'seek');
    const res = comp.render(desc, player.sources, 1);
    if (res.missing) {
      // Media still loading: try once more after decoders settle.
      await new Promise((r) => setTimeout(r, 300));
      await player.sources.prepare(desc, 'seek');
      comp.render(desc, player.sources, 1);
    }
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const safe = p.name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'frame';
    downloadBlob(blob, `${safe} ${formatTimecode(t, p.settings.fps).replace(/:/g, '-')}.png`);
    toast({ kind: 'success', message: `Saved a ${width}×${height} still.`, timeout: 2000 });
  } catch (e) {
    toast({ kind: 'error', message: 'Could not save the frame.', detail: (e as Error).message });
  } finally {
    comp?.dispose();
  }
}
