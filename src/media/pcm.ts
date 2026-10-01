/**
 * Random access to conformed audio (16-bit interleaved PCM files in OPFS).
 * Data is loaded in fixed-size chunks into a global LRU cache so the mixer can
 * read samples synchronously after an async `ensure()`. Works in the main
 * thread (preview) and in workers (export).
 */

const CHUNK_FRAMES = 65536;
const CACHE_BUDGET_BYTES = 128 * 1024 * 1024;

interface Chunk {
  /** Planar float data: one Float32Array per channel. */
  data: Float32Array[];
  bytes: number;
}

class ChunkCache {
  private map = new Map<string, Chunk>();
  private bytes = 0;

  get(key: string): Chunk | undefined {
    const c = this.map.get(key);
    if (c) {
      // refresh LRU position
      this.map.delete(key);
      this.map.set(key, c);
    }
    return c;
  }

  set(key: string, chunk: Chunk) {
    const old = this.map.get(key);
    if (old) this.bytes -= old.bytes;
    this.map.set(key, chunk);
    this.bytes += chunk.bytes;
    while (this.bytes > CACHE_BUDGET_BYTES && this.map.size > 1) {
      const first = this.map.keys().next().value as string;
      const c = this.map.get(first)!;
      this.map.delete(first);
      this.bytes -= c.bytes;
    }
  }

  dropPrefix(prefix: string) {
    for (const [k, c] of this.map) {
      if (k.startsWith(prefix)) {
        this.map.delete(k);
        this.bytes -= c.bytes;
      }
    }
  }
}

const cache = new ChunkCache();

export class PcmSource {
  readonly frames: number;
  private pending = new Map<number, Promise<void>>();

  constructor(
    readonly id: string,
    private readonly file: Blob,
    readonly sampleRate: number,
    readonly channels: number,
  ) {
    this.frames = Math.floor(file.size / (2 * channels));
  }

  get blob(): Blob {
    return this.file;
  }

  private key(idx: number) {
    return `${this.id}:${idx}`;
  }

  private async load(idx: number): Promise<void> {
    const startFrame = idx * CHUNK_FRAMES;
    const endFrame = Math.min(this.frames, startFrame + CHUNK_FRAMES);
    const n = Math.max(0, endFrame - startFrame);
    const bytesPerFrame = 2 * this.channels;
    const buf = await this.file.slice(startFrame * bytesPerFrame, endFrame * bytesPerFrame).arrayBuffer();
    const i16 = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
    const data: Float32Array[] = [];
    for (let c = 0; c < this.channels; c++) data.push(new Float32Array(n));
    const inv = 1 / 32768;
    if (this.channels === 1) {
      const d0 = data[0];
      for (let i = 0; i < n; i++) d0[i] = i16[i] * inv;
    } else {
      const d0 = data[0];
      const d1 = data[1];
      for (let i = 0; i < n; i++) {
        d0[i] = i16[i * 2] * inv;
        d1[i] = i16[i * 2 + 1] * inv;
      }
    }
    cache.set(this.key(idx), { data, bytes: n * this.channels * 4 });
  }

  /** Make sure frames [from, to) are resident. */
  ensure(fromFrame: number, toFrame: number): Promise<void> {
    const a = Math.max(0, Math.floor(fromFrame / CHUNK_FRAMES));
    const b = Math.min(Math.floor((this.frames - 1) / CHUNK_FRAMES), Math.floor(Math.max(fromFrame, toFrame - 1) / CHUNK_FRAMES));
    const waits: Promise<void>[] = [];
    for (let i = a; i <= b; i++) {
      if (cache.get(this.key(i))) continue;
      let p = this.pending.get(i);
      if (!p) {
        p = this.load(i).finally(() => this.pending.delete(i));
        this.pending.set(i, p);
      }
      waits.push(p);
    }
    return waits.length ? Promise.all(waits).then(() => undefined) : Promise.resolve();
  }

  /**
   * Copy frames starting at (possibly fractional) `start` into `out` (one
   * array per output channel, stereo) with cubic interpolation and the given
   * step (playback rate * sourceRate / outputRate). Frames that are not
   * resident or out of range read as silence. Returns false if any needed
   * chunk was missing.
   */
  read(start: number, step: number, count: number, outL: Float32Array, outR: Float32Array, gains: Float32Array, pans: Float32Array, outOffset = 0): boolean {
    let complete = true;
    let chunkIdx = -1;
    let chunk: Chunk | undefined;
    const fetch = (frame: number, ch: number): number => {
      if (frame < 0 || frame >= this.frames) return 0;
      const ci = (frame / CHUNK_FRAMES) | 0;
      if (ci !== chunkIdx) {
        chunkIdx = ci;
        chunk = cache.get(this.key(ci));
        if (!chunk) complete = false;
      }
      if (!chunk) return 0;
      const d = chunk.data[ch] ?? chunk.data[0];
      return d[frame - ci * CHUNK_FRAMES];
    };
    const stereo = this.channels > 1;
    let pos = start;
    for (let i = 0; i < count; i++, pos += step) {
      const i1 = Math.floor(pos);
      const f = pos - i1;
      let l: number;
      let r: number;
      if (f < 1e-6) {
        l = fetch(i1, 0);
        r = stereo ? fetch(i1, 1) : l;
      } else {
        l = cubic(fetch(i1 - 1, 0), fetch(i1, 0), fetch(i1 + 1, 0), fetch(i1 + 2, 0), f);
        r = stereo ? cubic(fetch(i1 - 1, 1), fetch(i1, 1), fetch(i1 + 1, 1), fetch(i1 + 2, 1), f) : l;
      }
      const g = gains[i];
      const pan = pans[i];
      // Constant-power-ish pan law that leaves center at unity.
      const gl = pan > 0 ? 1 - pan : 1;
      const gr = pan < 0 ? 1 + pan : 1;
      outL[outOffset + i] += l * g * gl;
      outR[outOffset + i] += r * g * gr;
    }
    return complete;
  }

  /** Raw access to a single frame of a channel (for analysis). */
  sample(frame: number, ch: number): number {
    if (frame < 0 || frame >= this.frames) return 0;
    const ci = (frame / CHUNK_FRAMES) | 0;
    const chunk = cache.get(this.key(ci));
    if (!chunk) return 0;
    return (chunk.data[ch] ?? chunk.data[0])[frame - ci * CHUNK_FRAMES];
  }

  dispose() {
    cache.dropPrefix(this.id + ':');
  }
}

function cubic(y0: number, y1: number, y2: number, y3: number, t: number): number {
  // Catmull-Rom spline
  const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
  const a1 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const a2 = -0.5 * y0 + 0.5 * y2;
  return ((a0 * t + a1) * t + a2) * t + y1;
}
