
import { ALL_FORMATS, AudioSampleSink, BlobSource, CanvasSink, Input } from 'mediabunny';

/**
 * Background media preparation, off the main thread:
 *  1. copy the original file into OPFS (so projects survive reloads),
 *  2. decode ("conform") the audio track to 16-bit PCM in OPFS + waveform peaks,
 *  3. render a sprite sheet of filmstrip thumbnails.
 */

export interface AnalyzeRequest {
  type: 'analyze';
  jobId: string;
  assetId: string;
  file: File;
  copy: boolean;
  thumbs: boolean;
  audio: boolean;
}

export interface CancelRequest {
  type: 'cancel';
  jobId: string;
}

export interface AnalyzeProgress {
  type: 'progress';
  jobId: string;
  stage: 'copy' | 'audio' | 'thumbs';
  value: number;
}

export interface AnalyzeDone {
  type: 'done';
  jobId: string;
  stored: boolean;
  storeError?: string;
  pcm: { sampleRate: number; channels: number; frames: number } | null;
  /** Set when OPFS was unavailable: the conformed PCM itself (transferred). */
  pcmBuffer?: ArrayBuffer;
  audioError?: string;
  peaks: { rate: number; data: Uint8Array } | null;
  thumbs: {
    blob: Blob;
    cols: number;
    rows: number;
    count: number;
    thumbWidth: number;
    thumbHeight: number;
    interval: number;
    start: number;
  } | null;
}

export interface AnalyzeError {
  type: 'error';
  jobId: string;
  message: string;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;
const cancelled = new Set<string>();

scope.onmessage = (ev: MessageEvent<AnalyzeRequest | CancelRequest>) => {
  const msg = ev.data;
  if (msg.type === 'cancel') {
    cancelled.add(msg.jobId);
    return;
  }
  if (msg.type === 'analyze') {
    run(msg).catch((e) => {
      scope.postMessage({ type: 'error', jobId: msg.jobId, message: String((e as Error)?.message ?? e) } satisfies AnalyzeError);
    });
  }
};

function progress(jobId: string, stage: AnalyzeProgress['stage'], value: number) {
  scope.postMessage({ type: 'progress', jobId, stage, value } satisfies AnalyzeProgress);
}

class Cancelled extends Error {}

function checkCancel(jobId: string) {
  if (cancelled.has(jobId)) throw new Cancelled('cancelled');
}

async function opfsDir(name: string) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

async function copyToOpfs(req: AnalyzeRequest): Promise<void> {
  const dir = await opfsDir('media');
  const fh = await dir.getFileHandle(req.assetId, { create: true });
  const handle = await fh.createSyncAccessHandle();
  try {
    handle.truncate(0);
    const reader = req.file.stream().getReader();
    let pos = 0;
    const total = req.file.size || 1;
    let lastReport = 0;
    for (;;) {
      checkCancel(req.jobId);
      const { done, value } = await reader.read();
      if (done) break;
      handle.write(value, { at: pos });
      pos += value.byteLength;
      if (pos - lastReport > 4 * 1024 * 1024) {
        lastReport = pos;
        progress(req.jobId, 'copy', pos / total);
      }
    }
    handle.flush();
  } catch (e) {
    handle.close();
    await dir.removeEntry(req.assetId).catch(() => {});
    throw e;
  }
  handle.close();
  progress(req.jobId, 'copy', 1);
}

const PEAK_RATE = 100;

/** Where conformed PCM goes: a file in OPFS, or memory when OPFS isn't available (private browsing). */
interface PcmSink {
  write(bytes: Uint8Array, at: number): void;
  finish(): ArrayBuffer | null;
  abort(): Promise<void>;
}

const MAX_MEMORY_PCM = 768 * 1024 * 1024;

async function openPcmSink(assetId: string, byteLength: number): Promise<PcmSink> {
  try {
    const dir = await opfsDir('pcm');
    const fh = await dir.getFileHandle(assetId + '.pcm', { create: true });
    const handle = await fh.createSyncAccessHandle();
    handle.truncate(byteLength);
    return {
      write: (bytes, at) => void handle.write(bytes, { at }),
      finish: () => {
        handle.flush();
        handle.close();
        return null;
      },
      abort: async () => {
        handle.close();
        await dir.removeEntry(assetId + '.pcm').catch(() => {});
      },
    };
  } catch {
    if (byteLength > MAX_MEMORY_PCM) throw new Error('Not enough local storage to prepare this audio, and it is too long to keep in memory.');
    const mem = new Uint8Array(byteLength);
    return {
      write: (bytes, at) => mem.set(bytes.subarray(0, Math.max(0, Math.min(bytes.length, byteLength - at))), at),
      finish: () => mem.buffer,
      abort: async () => {},
    };
  }
}

async function conformAudio(req: AnalyzeRequest): Promise<{ pcm: AnalyzeDone['pcm']; peaks: AnalyzeDone['peaks']; buffer: ArrayBuffer | null }> {
  const input = new Input({ source: new BlobSource(req.file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return { pcm: null, peaks: null, buffer: null };
    const sampleRate = await track.getSampleRate();
    const chIn = await track.getNumberOfChannels();
    const chOut = chIn >= 2 ? 2 : 1;
    const duration = await input.computeDuration();
    const totalFrames = Math.ceil(duration * sampleRate);
    const bucket = sampleRate / PEAK_RATE;
    const peaks = new Uint8Array(Math.ceil(duration * PEAK_RATE) + 1);

    const sink = await openPcmSink(req.assetId, totalFrames * chOut * 2);
    let buffer: ArrayBuffer | null = null;
    try {
      const samples = new AudioSampleSink(track);
      let planes: Float32Array[] = [];
      let out = new Int16Array(0);
      let lastReport = 0;
      for await (const sample of samples.samples()) {
        try {
          checkCancel(req.jobId);
          const n = sample.numberOfFrames;
          const ch = sample.numberOfChannels;
          if (planes.length < ch || planes[0].length < n) {
            planes = Array.from({ length: ch }, () => new Float32Array(n));
          }
          for (let c = 0; c < ch; c++) sample.copyTo(planes[c], { planeIndex: c, format: 'f32-planar', frameCount: n });
          let startFrame = Math.round(sample.timestamp * sampleRate);
          let skip = 0;
          if (startFrame < 0) {
            skip = -startFrame;
            startFrame = 0;
          }
          const count = Math.min(n - skip, totalFrames - startFrame);
          if (count <= 0) continue;
          if (out.length < count * chOut) out = new Int16Array(count * chOut);
          for (let i = 0; i < count; i++) {
            const si = i + skip;
            let l: number;
            let r: number;
            if (ch === 1) {
              l = r = planes[0][si];
            } else if (ch === 2) {
              l = planes[0][si];
              r = planes[1][si];
            } else {
              // ITU-style downmix for surround (L R C LFE Ls Rs ...).
              const C = planes[2]?.[si] ?? 0;
              const Ls = planes[4]?.[si] ?? 0;
              const Rs = planes[5]?.[si] ?? 0;
              l = (planes[0][si] + 0.707 * C + 0.707 * Ls) / 1.6;
              r = (planes[1][si] + 0.707 * C + 0.707 * Rs) / 1.6;
            }
            if (chOut === 1) {
              out[i] = toI16(l);
            } else {
              out[i * 2] = toI16(l);
              out[i * 2 + 1] = toI16(r);
            }
            const a = Math.max(Math.abs(l), Math.abs(r));
            const b = Math.floor((startFrame + i) / bucket);
            const v = Math.min(255, Math.round(Math.sqrt(Math.min(1, a)) * 255));
            if (v > peaks[b]) peaks[b] = v;
          }
          sink.write(new Uint8Array(out.buffer, 0, count * chOut * 2), startFrame * chOut * 2);
          if (sample.timestamp - lastReport > 2) {
            lastReport = sample.timestamp;
            progress(req.jobId, 'audio', Math.min(1, sample.timestamp / duration));
          }
        } finally {
          sample.close();
        }
      }
      buffer = sink.finish();
    } catch (e) {
      await sink.abort();
      throw e;
    }
    progress(req.jobId, 'audio', 1);
    return { pcm: { sampleRate, channels: chOut, frames: totalFrames }, peaks: { rate: PEAK_RATE, data: peaks }, buffer };
  } finally {
    input.dispose();
  }
}

function toI16(v: number): number {
  const s = v < -1 ? -1 : v > 1 ? 1 : v;
  return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
}

async function makeThumbs(req: AnalyzeRequest): Promise<AnalyzeDone['thumbs']> {
  const input = new Input({ source: new BlobSource(req.file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return null;
    const dw = await track.getDisplayWidth();
    const dh = await track.getDisplayHeight();
    const start = await track.getFirstTimestamp();
    const duration = await track.computeDuration();
    const len = Math.max(0.04, duration - start);
    const thumbHeight = 90;
    const thumbWidth = Math.max(16, Math.min(320, Math.round((thumbHeight * dw) / Math.max(1, dh))));
    const interval = Math.max(0.5, len / 240);
    const count = Math.max(1, Math.min(240, Math.ceil(len / interval)));
    const cols = Math.min(16, count);
    const rows = Math.ceil(count / cols);
    const sprite = new OffscreenCanvas(cols * thumbWidth, rows * thumbHeight);
    const ctx = sprite.getContext('2d')!;
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, sprite.width, sprite.height);
    const sink = new CanvasSink(track, { width: thumbWidth, height: thumbHeight, fit: 'cover', poolSize: 2 });
    const stamps = Array.from({ length: count }, (_, i) => Math.min(start + i * interval + 0.001, start + len - 0.001));
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(stamps)) {
      checkCancel(req.jobId);
      if (wc) ctx.drawImage(wc.canvas, (i % cols) * thumbWidth, Math.floor(i / cols) * thumbHeight);
      i++;
      if (i % 12 === 0) progress(req.jobId, 'thumbs', i / count);
    }
    const blob = await sprite.convertToBlob({ type: 'image/jpeg', quality: 0.72 });
    progress(req.jobId, 'thumbs', 1);
    return { blob, cols, rows, count, thumbWidth, thumbHeight, interval, start };
  } finally {
    input.dispose();
  }
}

async function run(req: AnalyzeRequest) {
  const result: AnalyzeDone = { type: 'done', jobId: req.jobId, stored: false, pcm: null, peaks: null, thumbs: null };
  try {
    const tasks: Promise<void>[] = [];
    if (req.thumbs) {
      tasks.push(
        makeThumbs(req)
          .then((t) => void (result.thumbs = t))
          .catch((e) => {
            if (e instanceof Cancelled) throw e;
            console.warn('Thumbnail generation failed', e);
          }),
      );
    }
    if (req.audio) {
      tasks.push(
        conformAudio(req)
          .then((r) => {
            result.pcm = r.pcm;
            result.peaks = r.peaks;
            if (r.buffer) result.pcmBuffer = r.buffer;
          })
          .catch((e) => {
            if (e instanceof Cancelled) throw e;
            result.audioError = describeStorageError(e);
          }),
      );
    }
    if (req.copy) {
      tasks.push(
        copyToOpfs(req)
          .then(() => void (result.stored = true))
          .catch((e) => {
            if (e instanceof Cancelled) throw e;
            result.storeError = describeStorageError(e);
          }),
      );
    }
    await Promise.all(tasks);
    (scope as unknown as { postMessage(m: unknown, t?: Transferable[]): void }).postMessage(result, result.pcmBuffer ? [result.pcmBuffer] : []);
  } catch (e) {
    if (e instanceof Cancelled) {
      scope.postMessage({ type: 'error', jobId: req.jobId, message: 'cancelled' } satisfies AnalyzeError);
    } else throw e;
  } finally {
    cancelled.delete(req.jobId);
  }
}

function describeStorageError(e: unknown): string {
  const name = (e as DOMException)?.name;
  if (name === 'QuotaExceededError') return 'Not enough local storage space.';
  return String((e as Error)?.message ?? e);
}
