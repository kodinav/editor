import { audibleSegments, audioSourceTime, clipGainAt, clipPanAt, type AudioSegment } from '@/core/audio';
import type { Project } from '@/core/types';
import type { PcmSource } from '@/media/pcm';

/**
 * Deterministic offline/streaming mixer. Given a project and a time range it
 * produces stereo float PCM. The same code renders realtime preview blocks
 * and export blocks, so what you hear while editing is what gets exported.
 *
 * Speed changes either resample (pitch follows speed) or time-stretch with a
 * stateless overlap-add whose grains are aligned by cross-correlation
 * (WSOLA-style). Every grain is a pure function of its index, so playback can
 * start anywhere and still match the export sample-for-sample.
 */

export interface MixSources {
  /** `variant` 'nr' selects the noise-reduced audio when it exists. */
  getPcm(assetId: string, variant?: 'nr'): PcmSource | undefined;
}

const CONTROL_STEP = 64;

/** Grain hop (seconds) and search tolerance for pitch-preserving stretch. */
const HOP = 0.03;
const SEARCH = 0.012;

export class AudioMixer {
  private gains = new Float32Array(0);
  private pans = new Float32Array(0);
  private grainCache = new Map<string, number>();

  constructor(
    private readonly sources: MixSources,
    readonly sampleRate: number,
  ) {}

  private pcmFor(seg: AudioSegment): PcmSource | undefined {
    return (seg.clip.denoise ? this.sources.getPcm(seg.assetId, 'nr') : undefined) ?? this.sources.getPcm(seg.assetId);
  }

  /** Load all PCM needed for [t0, t0 + frames/sr). */
  async prepare(p: Project, t0: number, frames: number): Promise<void> {
    const t1 = t0 + frames / this.sampleRate;
    const waits: Promise<void>[] = [];
    for (const seg of audibleSegments(p, t0, t1)) {
      const pcm = this.pcmFor(seg);
      if (!pcm) continue;
      const a = Math.max(t0, seg.start);
      const b = Math.min(t1, seg.end);
      const s0 = audioSourceTime(seg, a);
      const s1 = audioSourceTime(seg, b);
      const pad = seg.clip.speed !== 1 && seg.clip.preservePitch ? HOP * 2 + SEARCH * 2 + 0.05 : 0.01;
      waits.push(pcm.ensure(Math.floor((Math.min(s0, s1) - pad) * pcm.sampleRate), Math.ceil((Math.max(s0, s1) + pad) * pcm.sampleRate)));
    }
    await Promise.all(waits);
  }

  /**
   * Mix [t0, t0 + frames/sr) into outL/outR (overwritten). Returns true if all
   * needed audio was resident.
   */
  mix(p: Project, t0: number, frames: number, outL: Float32Array, outR: Float32Array): boolean {
    outL.fill(0, 0, frames);
    outR.fill(0, 0, frames);
    if (this.gains.length < frames) {
      this.gains = new Float32Array(frames);
      this.pans = new Float32Array(frames);
    }
    const sr = this.sampleRate;
    const t1 = t0 + frames / sr;
    let complete = true;
    for (const seg of audibleSegments(p, t0, t1)) {
      const pcm = this.pcmFor(seg);
      if (!pcm) continue;
      const a = Math.max(t0, seg.start);
      const b = Math.min(t1, seg.end);
      const i0 = Math.max(0, Math.ceil((a - t0) * sr - 1e-6));
      const i1 = Math.min(frames, Math.ceil((b - t0) * sr - 1e-6));
      const n = i1 - i0;
      if (n <= 0) continue;
      this.computeEnvelope(p, seg, t0, i0, n);
      const speed = seg.clip.speed;
      if (Math.abs(speed - 1) < 1e-6 || !seg.clip.preservePitch) {
        const tStart = t0 + i0 / sr;
        const srcPos = audioSourceTime(seg, tStart) * pcm.sampleRate;
        const step = (speed * pcm.sampleRate) / sr;
        if (!pcm.read(srcPos, step, n, outL, outR, this.gains, this.pans, i0)) complete = false;
      } else {
        if (!this.stretch(seg, pcm, t0, i0, n, outL, outR)) complete = false;
      }
    }
    return complete;
  }

  private computeEnvelope(p: Project, seg: AudioSegment, t0: number, i0: number, n: number) {
    const sr = this.sampleRate;
    const g = this.gains;
    const pn = this.pans;
    let prevG = clipGainAt(p, seg, t0 + i0 / sr);
    let prevP = clipPanAt(seg, t0 + i0 / sr);
    for (let k = 0; k < n; k += CONTROL_STEP) {
      const m = Math.min(CONTROL_STEP, n - k);
      const tEnd = t0 + (i0 + k + m) / sr;
      // Evaluate slightly inside the segment at its very end so fades reach zero.
      const nextG = clipGainAt(p, seg, Math.min(tEnd, seg.end - 1e-7));
      const nextP = clipPanAt(seg, Math.min(tEnd, seg.end - 1e-7));
      for (let j = 0; j < m; j++) {
        const f = (j + 1) / m;
        g[k + j] = prevG + (nextG - prevG) * f;
        pn[k + j] = prevP + (nextP - prevP) * f;
      }
      prevG = nextG;
      prevP = nextP;
    }
  }

  /** Pitch-preserving time stretch via correlation-aligned overlap-add. */
  private stretch(seg: AudioSegment, pcm: PcmSource, t0: number, i0: number, n: number, outL: Float32Array, outR: Float32Array): boolean {
    const sr = this.sampleRate;
    const c = seg.clip;
    const srcRate = pcm.sampleRate;
    const step = srcRate / sr;
    const hop = HOP;
    const grainLen = hop * 2;
    let complete = true;
    const tmpL = new Float32Array(n);
    const tmpR = new Float32Array(n);
    const ones = new Float32Array(n);
    const zeros = new Float32Array(n);
    // Local (clip-relative) time of the first and last output sample.
    const lt0 = t0 + i0 / sr - c.start;
    const lt1 = lt0 + n / sr;
    const kFirst = Math.max(0, Math.floor(lt0 / hop) - 1);
    const kLast = Math.floor(lt1 / hop);
    for (let k = kFirst; k <= kLast; k++) {
      const T = k * hop;
      // Output sample span of this grain within the block.
      const gs = Math.max(0, Math.ceil((T - lt0) * sr - 1e-6));
      const ge = Math.min(n, Math.ceil((T + grainLen - lt0) * sr - 1e-6));
      if (ge <= gs) continue;
      const delta = this.grainOffset(seg, pcm, k);
      const srcStart = (c.sourceIn + T * c.speed + delta) * srcRate;
      const count = ge - gs;
      tmpL.fill(0, 0, count);
      tmpR.fill(0, 0, count);
      ones.fill(1, 0, count);
      const firstLocal = lt0 + gs / sr - T;
      if (!pcm.read(srcStart + firstLocal * srcRate, step, count, tmpL, tmpR, ones, zeros, 0)) complete = false;
      for (let j = 0; j < count; j++) {
        const u = (firstLocal + j / sr) / grainLen;
        const w = u <= 0 || u >= 1 ? 0 : 0.5 - 0.5 * Math.cos(2 * Math.PI * u);
        const idx = gs + j;
        const g = this.gains[idx] * w;
        const pan = this.pans[idx];
        const gl = pan > 0 ? 1 - pan : 1;
        const gr = pan < 0 ? 1 + pan : 1;
        outL[i0 + idx] += tmpL[j] * g * gl;
        outR[i0 + idx] += tmpR[j] * g * gr;
      }
    }
    return complete;
  }

  /**
   * Source offset (seconds) that best aligns grain k with the natural
   * continuation of grain k-1. Depends only on source data, so it is
   * deterministic and cacheable.
   */
  private grainOffset(seg: AudioSegment, pcm: PcmSource, k: number): number {
    if (k === 0) return 0;
    const c = seg.clip;
    const key = `${c.id}:${c.sourceIn}:${c.speed}:${c.denoise ? 1 : 0}:${k}`;
    const cached = this.grainCache.get(key);
    if (cached !== undefined) return cached;
    const srcRate = pcm.sampleRate;
    const hop = HOP;
    // Where grain k-1 would naturally continue to at the start of grain k.
    const target = (c.sourceIn + (k - 1) * hop * c.speed + hop) * srcRate;
    const ideal = (c.sourceIn + k * hop * c.speed) * srcRate;
    const span = Math.floor(hop * srcRate * 0.5);
    const tol = Math.floor(SEARCH * srcRate);
    const dec = 4;
    let best = 0;
    let bestScore = -Infinity;
    for (let d = -tol; d <= tol; d += 2) {
      let s = 0;
      for (let i = 0; i < span; i += dec) {
        s += pcm.sample(Math.floor(target + i), 0) * pcm.sample(Math.floor(ideal + d + i), 0);
      }
      if (s > bestScore) {
        bestScore = s;
        best = d;
      }
    }
    const off = best / srcRate;
    if (this.grainCache.size > 4096) this.grainCache.clear();
    this.grainCache.set(key, off);
    return off;
  }
}
