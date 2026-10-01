import type { Input, VideoSample } from 'mediabunny';
import type { FrameDesc } from '@/core/evaluate';
import { videoSourcesIn } from '@/core/evaluate';
import type { FrameSources } from '@/engine/compositor';
import { media } from '@/media/registry';
import { VideoReader } from '@/media/videoReader';

/**
 * Frame sources for the live preview: a pool of video readers keyed by clip
 * id (so two clips from the same file decode independently, e.g. both sides
 * of a transition), plus still images from the media registry.
 */

interface Entry {
  clipId: string;
  assetId: string;
  file: File;
  reader: VideoReader | null;
  input: Input | null;
  opening: Promise<void> | null;
  error: unknown;
  lastUsed: number;
}

const MAX_READERS = 12;
const IDLE_MS = 8000;

export class PreviewSources implements FrameSources {
  private entries = new Map<string, Entry>();
  onFrameReady: (() => void) | null = null;

  video = (clipId: string): VideoSample | null => this.entries.get(clipId)?.reader?.current ?? null;

  image = (assetId: string, time: number): ImageBitmap | null => media.image(assetId, time);

  private entry(clipId: string, assetId: string): Entry | null {
    const file = media.getFile(assetId);
    if (!file) return null;
    let e = this.entries.get(clipId);
    if (e && (e.assetId !== assetId || e.file !== file)) {
      this.close(e);
      e = undefined;
    }
    if (!e) {
      const entry: Entry = { clipId, assetId, file, reader: null, input: null, opening: null, error: null, lastUsed: performance.now() };
      entry.opening = VideoReader.open(file)
        .then(({ reader, input }) => {
          if (this.entries.get(clipId) !== entry) {
            reader.dispose();
            input.dispose();
            return;
          }
          entry.reader = reader;
          entry.input = input;
        })
        .catch((err) => {
          entry.error = err;
          console.warn('Could not open video for preview', err);
        })
        .finally(() => (entry.opening = null));
      this.entries.set(clipId, entry);
      e = entry;
    }
    e.lastUsed = performance.now();
    return e;
  }

  /**
   * Make frames for `desc` available. In 'seek' mode, waits until every
   * frame is decoded. In 'play' mode, only nudges decoders forward.
   */
  async prepare(desc: FrameDesc, mode: 'seek' | 'play'): Promise<void> {
    const wanted = videoSourcesIn(desc);
    const waits: Promise<unknown>[] = [];
    for (const w of wanted) {
      const e = this.entry(w.key, w.assetId);
      if (!e || e.error) continue;
      if (mode === 'play') {
        if (e.reader) e.reader.request(w.time);
        else if (e.opening) e.opening.then(() => e.reader?.request(w.time)).then(() => this.onFrameReady?.());
      } else {
        waits.push(
          (async () => {
            if (e.opening) await e.opening;
            if (e.reader) await e.reader.seek(w.time).catch((err) => console.warn('seek failed', err));
          })(),
        );
      }
    }
    if (waits.length) await Promise.all(waits);
    this.evict(new Set(wanted.map((w) => w.key)));
  }

  /** Warm up readers for clips about to start (avoids a stall at cuts). */
  preroll(desc: FrameDesc) {
    for (const w of videoSourcesIn(desc)) {
      const e = this.entry(w.key, w.assetId);
      if (!e || e.error) continue;
      const cur = e.reader?.current;
      if (e.reader && cur && Math.abs(cur.timestamp - w.time) < 0.5) continue;
      if (e.reader) void e.reader.seek(w.time).catch(() => {});
      else void e.opening?.then(() => e.reader?.seek(w.time).catch(() => {}));
    }
  }

  private evict(keep: Set<string>) {
    const now = performance.now();
    const list = [...this.entries.values()];
    for (const e of list) {
      if (!keep.has(e.clipId) && now - e.lastUsed > IDLE_MS) this.close(e);
    }
    if (this.entries.size > MAX_READERS) {
      const sorted = [...this.entries.values()].filter((e) => !keep.has(e.clipId)).sort((a, b) => a.lastUsed - b.lastUsed);
      while (this.entries.size > MAX_READERS && sorted.length) this.close(sorted.shift()!);
    }
  }

  private close(e: Entry) {
    this.entries.delete(e.clipId);
    e.reader?.dispose();
    e.input?.dispose();
  }

  /** Errors from video readers (e.g. decode failures) for UI reporting. */
  errors(): { clipId: string; error: unknown }[] {
    return [...this.entries.values()].filter((e) => e.error).map((e) => ({ clipId: e.clipId, error: e.error }));
  }

  dispose() {
    for (const e of [...this.entries.values()]) this.close(e);
  }
}
