import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';

/**
 * Shot-change detection. A coarse pass samples small frames a few times per
 * second and scores color-histogram + layout differences; each candidate is
 * then refined at the native frame rate to find the exact first frame of the
 * new shot.
 */

export interface ScenesRequest {
  type: 'detect';
  id: number;
  file: File;
  /** Source time range to scan (s). */
  start: number;
  end: number;
  /** 0 (only hard cuts) .. 1 (very sensitive). */
  sensitivity: number;
}

export type ScenesMessage = { type: 'progress'; id: number; value: number } | { type: 'result'; id: number; cuts: number[] } | { type: 'error'; id: number; message: string };

const W = 64;
const H = 36;
const COARSE_STEP = 1 / 6;
const MIN_SCENE = 0.8;

interface Features {
  hist: Float32Array;
  grid: Float32Array;
}

function features(canvas: OffscreenCanvas | HTMLCanvasElement): Features {
  const ctx = (canvas as OffscreenCanvas).getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
  const d = ctx.getImageData(0, 0, W, H).data;
  const hist = new Float32Array(48);
  const grid = new Float32Array(16);
  const n = W * H;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p];
    const g = d[p + 1];
    const b = d[p + 2];
    hist[r >> 4]++;
    hist[16 + (g >> 4)]++;
    hist[32 + (b >> 4)]++;
    const x = i % W;
    const y = (i / W) | 0;
    grid[((y * 4) / H | 0) * 4 + ((x * 4) / W | 0)] += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  for (let i = 0; i < 48; i++) hist[i] /= n;
  for (let i = 0; i < 16; i++) grid[i] /= n / 16;
  return { hist, grid };
}

function distance(a: Features, b: Features): number {
  let h = 0;
  for (let i = 0; i < 48; i++) h += Math.abs(a.hist[i] - b.hist[i]);
  h /= 6; // three histograms, each L1 distance in [0, 2]
  let g = 0;
  for (let i = 0; i < 16; i++) g += Math.abs(a.grid[i] - b.grid[i]);
  g /= 16 * 255;
  return 0.6 * h + 0.4 * g;
}

const post = (m: ScenesMessage) => (self as unknown as { postMessage(m: ScenesMessage): void }).postMessage(m);

async function detect(req: ScenesRequest): Promise<number[]> {
  const input = new Input({ source: new BlobSource(req.file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return [];
    const sink = new CanvasSink(track, { width: W, height: H, fit: 'fill', poolSize: 2 });
    let fps = 30;
    try {
      const stats = await track.computePacketStats(120);
      if (stats.averagePacketRate > 1) fps = stats.averagePacketRate;
    } catch {
      /* default */
    }
    const first = await track.getFirstTimestamp().catch(() => 0);
    const start = Math.max(req.start, first);
    const stamps: number[] = [];
    for (let t = start; t < req.end; t += COARSE_STEP) stamps.push(t);
    const feats: Features[] = [];
    const times: number[] = [];
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(stamps)) {
      i++;
      if (!wc) continue;
      feats.push(features(wc.canvas));
      times.push(wc.timestamp);
      if (i % 30 === 0) post({ type: 'progress', id: req.id, value: (0.8 * i) / stamps.length });
    }
    const scores = feats.map((f, k) => (k === 0 ? 0 : distance(feats[k - 1], f)));
    // Threshold relative to the clip's own motion level, never below an absolute floor.
    const sorted = [...scores].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const floor = 0.45 - 0.3 * Math.min(1, Math.max(0, req.sensitivity));
    const thr = Math.max(floor, median * 4);
    const candidates: number[] = [];
    for (let k = 1; k < scores.length; k++) {
      const s = scores[k];
      if (s < thr) continue;
      if (s < (scores[k - 1] ?? 0) || s < (scores[k + 1] ?? 0)) continue;
      candidates.push(k);
    }
    // Refine each candidate to the exact first frame of the new shot.
    const cuts: number[] = [];
    let c = 0;
    for (const k of candidates) {
      c++;
      const a = times[k - 1];
      const b = times[k];
      const fine: number[] = [];
      for (let t = a; t <= b + 1e-6; t += 1 / fps) fine.push(t + 1e-4);
      let prev: Features | null = null;
      let best = b;
      let bestS = -1;
      for await (const wc of sink.canvasesAtTimestamps(fine)) {
        if (!wc) continue;
        const f = features(wc.canvas);
        if (prev) {
          const s = distance(prev, f);
          if (s > bestS) {
            bestS = s;
            best = wc.timestamp;
          }
        }
        prev = f;
      }
      if (cuts.length === 0 ? best - start >= MIN_SCENE : best - cuts[cuts.length - 1] >= MIN_SCENE) {
        if (req.end - best >= MIN_SCENE * 0.5) cuts.push(best);
      }
      post({ type: 'progress', id: req.id, value: 0.8 + (0.2 * c) / candidates.length });
    }
    return cuts;
  } finally {
    input.dispose();
  }
}

self.onmessage = (e: MessageEvent<ScenesRequest>) => {
  const req = e.data;
  if (req.type !== 'detect') return;
  detect(req).then(
    (cuts) => post({ type: 'result', id: req.id, cuts }),
    (err) => post({ type: 'error', id: req.id, message: String((err as Error)?.message ?? err) }),
  );
};
