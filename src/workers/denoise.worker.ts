import { FRAME, HOP, noiseProfile, NOISE_PRESETS, SpectralGate } from '@/core/dsp';

/**
 * Offline noise reduction over an asset's conformed 16-bit PCM. Streams the
 * file through a spectral gate per channel and writes a cleaned variant
 * (pcm/<id>.nr.pcm, or memory when OPFS isn't available).
 */

export interface DenoiseRequest {
  type: 'denoise';
  id: number;
  assetId: string;
  pcm: Blob;
  channels: number;
  preset: keyof typeof NOISE_PRESETS;
}

export type DenoiseMessage =
  | { type: 'progress'; id: number; value: number }
  | { type: 'done'; id: number; buffer?: ArrayBuffer }
  | { type: 'error'; id: number; message: string };

const post = (m: DenoiseMessage, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: DenoiseMessage, t: Transferable[]): void }).postMessage(m, transfer);

/** Sequential windowed reader over interleaved Int16 PCM. */
class PcmWindow {
  private start = 0;
  private len = 0;
  private data: Float32Array[] = [];
  constructor(
    private blob: Blob,
    private channels: number,
    readonly frames: number,
  ) {}

  /** Make frames [from, to) resident (to may exceed the file; reads as zeros). */
  async ensure(from: number, to: number) {
    if (from >= this.start && to <= this.start + this.len) return;
    const BLOCK = 1 << 18;
    const a = Math.max(0, from);
    const b = Math.min(this.frames, Math.max(to, a + BLOCK));
    const bytes = await this.blob.slice(a * 2 * this.channels, b * 2 * this.channels).arrayBuffer();
    const i16 = new Int16Array(bytes);
    const n = b - a;
    this.data = Array.from({ length: this.channels }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) for (let c = 0; c < this.channels; c++) this.data[c][i] = i16[i * this.channels + c] / 32768;
    this.start = a;
    this.len = n;
  }

  frameInto(ch: number, pos: number, out: Float32Array) {
    const d = this.data[ch];
    for (let i = 0; i < out.length; i++) {
      const n = pos + i;
      out[i] = n >= 0 && n < this.frames && n - this.start >= 0 && n - this.start < this.len ? d[n - this.start] : 0;
    }
  }
}

async function openOutput(assetId: string, bytes: number) {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('pcm', { create: true });
    const fh = await dir.getFileHandle(assetId + '.nr.pcm', { create: true });
    const h = await fh.createSyncAccessHandle();
    h.truncate(bytes);
    return {
      write: (b: Uint8Array, at: number) => void h.write(b, { at }),
      finish: (): ArrayBuffer | undefined => {
        h.flush();
        h.close();
        return undefined;
      },
    };
  } catch {
    const mem = new Uint8Array(bytes);
    return { write: (b: Uint8Array, at: number) => mem.set(b, at), finish: () => mem.buffer };
  }
}

async function run(req: DenoiseRequest) {
  const ch = req.channels;
  const total = Math.floor(req.pcm.size / (2 * ch));
  const reader = new PcmWindow(req.pcm, ch, total);

  // 1. Noise profile from up to ~3000 frames spread across the file (mono mix).
  const stride = Math.max(HOP * 2, Math.floor(Math.max(1, total - FRAME) / 3000));
  const frames: Float32Array[] = [];
  const tmp = new Float32Array(FRAME);
  for (let p = 0; p + FRAME <= total; p += stride) {
    await reader.ensure(p, p + FRAME);
    const f = new Float32Array(FRAME);
    for (let c = 0; c < ch; c++) {
      reader.frameInto(c, p, tmp);
      for (let i = 0; i < FRAME; i++) f[i] += tmp[i] / ch;
    }
    frames.push(f);
  }
  if (frames.length < 4) throw new Error('This audio is too short to analyze for noise.');
  const profile = noiseProfile(frames);
  post({ type: 'progress', id: req.id, value: 0.1 });

  // 2. Gate every channel and write interleaved 16-bit output.
  const gates = Array.from({ length: ch }, () => new SpectralGate(profile, NOISE_PRESETS[req.preset]));
  const out = await openOutput(req.assetId, total * ch * 2);
  const frame = new Float32Array(FRAME);
  const outI16 = new Int16Array(HOP * ch);
  let lastReport = 0;
  for (let k = -3; k * HOP < total; k++) {
    const pos = k * HOP;
    await reader.ensure(pos, pos + FRAME);
    const chunks: Float32Array[] = [];
    for (let c = 0; c < ch; c++) {
      reader.frameInto(c, pos, frame);
      chunks.push(gates[c].process(frame));
    }
    if (k < 0) continue;
    const n = Math.min(HOP, total - pos);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, chunks[c][i]));
        outI16[i * ch + c] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
      }
    }
    out.write(new Uint8Array(outI16.buffer, 0, n * ch * 2), pos * ch * 2);
    if (pos - lastReport > total / 50) {
      lastReport = pos;
      post({ type: 'progress', id: req.id, value: 0.1 + (0.9 * pos) / total });
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const buffer = out.finish();
  post({ type: 'done', id: req.id, buffer }, buffer ? [buffer] : []);
}

self.onmessage = (e: MessageEvent<DenoiseRequest>) => {
  if (e.data.type !== 'denoise') return;
  run(e.data).catch((err) => post({ type: 'error', id: e.data.id, message: String((err as Error)?.message ?? err) }));
};
