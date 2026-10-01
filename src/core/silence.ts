/**
 * Silence detection on decoded audio. Works on a window-RMS stream so it can
 * scan hour-long sources without holding them in memory.
 */

export interface SilenceOptions {
  /** Windows quieter than this (dBFS RMS) count as silence. */
  thresholdDb: number;
  /** Ignore pauses shorter than this (seconds). */
  minSilence: number;
  /** Keep this much audio on each side of a cut (seconds). */
  padding: number;
}

export interface Region {
  start: number;
  end: number;
}

export const DEFAULT_SILENCE: SilenceOptions = { thresholdDb: -40, minSilence: 0.6, padding: 0.15 };

/**
 * Given per-window RMS values (linear) starting at `t0` with window length
 * `win` seconds, return silent regions (in the same time base) after padding.
 */
export function silentRegions(rms: ArrayLike<number>, t0: number, win: number, opts: SilenceOptions): Region[] {
  const thr = Math.pow(10, opts.thresholdDb / 20);
  const out: Region[] = [];
  let runStart = -1;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const a = t0 + runStart * win;
    const b = t0 + endIdx * win;
    if (b - a >= opts.minSilence) {
      // Padding keeps breaths around speech; silence at the very edges is removed entirely.
      const s = runStart === 0 ? a : a + opts.padding;
      const e = endIdx >= rms.length ? b : b - opts.padding;
      if (e - s > 0.05) out.push({ start: s, end: e });
    }
    runStart = -1;
  };
  for (let i = 0; i < rms.length; i++) {
    if (rms[i] < thr) {
      if (runStart < 0) runStart = i;
    } else flush(i);
  }
  flush(rms.length);
  return out;
}

/** Compute windowed RMS from a sample accessor (mono mixdown of up to two channels). */
export function windowRms(
  sample: (frame: number, ch: number) => number,
  channels: number,
  fromFrame: number,
  toFrame: number,
  windowFrames: number,
): Float32Array {
  const n = Math.max(0, Math.ceil((toFrame - fromFrame) / windowFrames));
  const out = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    const a = fromFrame + w * windowFrames;
    const b = Math.min(toFrame, a + windowFrames);
    let acc = 0;
    for (let f = a; f < b; f++) {
      let v = sample(f, 0);
      if (channels > 1) v = (v + sample(f, 1)) * 0.5;
      acc += v * v;
    }
    out[w] = Math.sqrt(acc / Math.max(1, b - a));
  }
  return out;
}
