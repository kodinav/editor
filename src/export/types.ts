import type { Project } from '@/core/types';

export type ExportContainer = 'mp4' | 'webm' | 'mov' | 'm4a' | 'wav';
export type ExportQuality = 'low' | 'medium' | 'high' | 'best';

export interface ExportOptions {
  container: ExportContainer;
  /** Output pixel size (aspect matches the project). Ignored for audio-only. */
  width: number;
  height: number;
  fps: number;
  quality: ExportQuality;
  /** Seconds, [start, end). */
  start: number;
  end: number;
  includeAudio: boolean;
  fileName: string;
  /** Prefer hardware encoders (faster) or software (more compatible). */
  hardware: 'no-preference' | 'prefer-hardware' | 'prefer-software';
}

export interface ExportStartMessage {
  type: 'start';
  project: Project;
  files: Record<string, File>;
  pcm: Record<string, { file: File; sampleRate: number; channels: number }>;
  fonts: Record<string, ArrayBuffer>;
  options: ExportOptions;
  /** Where to write: a user-chosen file, or an OPFS temp file (by name). */
  target: { kind: 'handle'; handle: FileSystemFileHandle } | { kind: 'opfs'; name: string };
}

export type ExportWorkerMessage =
  | { type: 'progress'; frame: number; totalFrames: number; fps: number; elapsed: number; phase: 'preparing' | 'rendering' | 'finalizing' }
  | { type: 'done'; bytes: number; mimeType: string; elapsed: number; videoCodec: string | null; audioCodec: string | null; buffer?: ArrayBuffer }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

/** Bits per pixel per frame by quality for H.264; other codecs scale from this. */
const BPP: Record<ExportQuality, number> = { low: 0.045, medium: 0.075, high: 0.11, best: 0.18 };

export function videoBitrate(w: number, h: number, fps: number, q: ExportQuality, codec: string): number {
  const eff = codec === 'avc' ? 1 : codec === 'vp8' ? 1.1 : 0.7;
  const bps = w * h * Math.min(fps, 60) * BPP[q] * eff;
  return Math.round(Math.max(500_000, Math.min(bps, 120_000_000)));
}

export function audioBitrate(q: ExportQuality): number {
  return q === 'low' ? 96_000 : q === 'medium' ? 160_000 : q === 'high' ? 192_000 : 256_000;
}

export function estimateBytes(o: ExportOptions, codec: string): number {
  const dur = Math.max(0, o.end - o.start);
  const audio = o.includeAudio ? (o.container === 'wav' ? 48000 * 2 * 2 * 8 : audioBitrate(o.quality)) : 0;
  const video = o.container === 'wav' || o.container === 'm4a' ? 0 : videoBitrate(o.width, o.height, o.fps, o.quality, codec);
  return ((video + audio) * dur) / 8;
}
