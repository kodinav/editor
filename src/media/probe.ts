import { ALL_FORMATS, BlobSource, Input, type InputAudioTrack, type InputVideoTrack } from 'mediabunny';
import type { AssetAudioInfo, AssetKind, AssetVideoInfo } from '@/core/types';

/**
 * Inspect an imported file and decide what kind of asset it is and whether
 * this browser can actually decode it. Every file is untrusted input: all
 * parsing goes through mediabunny / browser decoders, and failures become
 * readable messages rather than crashes.
 */

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ts', 'mts', 'm2ts', '3gp', 'qt', 'ogv', 'avi', 'wmv', 'flv'];
const AUDIO_EXT = ['mp3', 'wav', 'wave', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba', 'aif', 'aiff', 'caf', 'wma'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'svg', 'heic', 'heif', 'ico', 'tif', 'tiff'];
const FONT_EXT = ['ttf', 'otf', 'woff', 'woff2'];
export const SUBTITLE_EXT = ['srt', 'vtt'];

export type FileCategory = AssetKind | 'subtitle' | 'project' | 'unknown';

export function extOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function categorize(file: File): FileCategory {
  const ext = extOf(file.name);
  const mime = file.type;
  if (ext === 'cutline' || ext === 'cutproj') return 'project';
  if (SUBTITLE_EXT.includes(ext)) return 'subtitle';
  if (FONT_EXT.includes(ext) || mime.startsWith('font/')) return 'font';
  if (mime.startsWith('image/') || IMAGE_EXT.includes(ext)) return 'image';
  if (mime.startsWith('audio/') || AUDIO_EXT.includes(ext)) return 'audio';
  if (mime.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video';
  return 'unknown';
}

export const ACCEPT_ATTR = [
  'video/*',
  'audio/*',
  'image/*',
  ...[...VIDEO_EXT, ...AUDIO_EXT, ...IMAGE_EXT, ...FONT_EXT, ...SUBTITLE_EXT, 'cutline'].map((e) => '.' + e),
].join(',');

export interface ProbeResult {
  kind: AssetKind;
  duration: number;
  video?: AssetVideoInfo;
  audio?: Omit<AssetAudioInfo, 'conformed'>;
  image?: { width: number; height: number };
  /** Non-fatal issues to surface to the user. */
  warnings: string[];
}

export class ProbeError extends Error {}

const CODEC_NAMES: Record<string, string> = {
  avc: 'H.264',
  hevc: 'H.265/HEVC',
  vp8: 'VP8',
  vp9: 'VP9',
  av1: 'AV1',
  prores: 'ProRes',
  aac: 'AAC',
  opus: 'Opus',
  mp3: 'MP3',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  ac3: 'Dolby AC-3',
  eac3: 'Dolby E-AC-3',
  dts: 'DTS',
};

export function codecLabel(c: string | null | undefined): string {
  if (!c) return 'unknown codec';
  if (c.startsWith('pcm')) return 'PCM';
  return CODEC_NAMES[c] ?? c;
}

async function probeVideoTrack(track: InputVideoTrack): Promise<AssetVideoInfo> {
  const [codec, rotation, w, h, canAlpha] = await Promise.all([
    track.getCodec(),
    track.getRotation(),
    track.getSquarePixelWidth(),
    track.getSquarePixelHeight(),
    track.canBeTransparent().catch(() => false),
  ]);
  let fps = 30;
  try {
    const stats = await track.computePacketStats(120);
    if (stats.averagePacketRate > 1 && stats.averagePacketRate < 400) fps = stats.averagePacketRate;
  } catch {
    /* keep default */
  }
  return { width: w, height: h, rotation, fps: Math.round(fps * 1000) / 1000, codec, hasAlpha: !!canAlpha };
}

async function probeAudioTrack(track: InputAudioTrack): Promise<Omit<AssetAudioInfo, 'conformed'>> {
  const [codec, sampleRate, channels] = await Promise.all([track.getCodec(), track.getSampleRate(), track.getNumberOfChannels()]);
  return { codec, sampleRate, channels };
}

/** Containers the browser pipeline can read; anything else is "unsupported" rather than "damaged". */
const READABLE_EXT = ['mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'ts', 'mts', 'm2ts', 'mp3', 'wav', 'wave', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba', '3gp', 'ogv'];

export async function probeAV(file: Blob, hint: 'video' | 'audio'): Promise<ProbeResult> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const ext = file instanceof File ? extOf(file.name) : '';
  const damaged = 'The file couldn’t be read. It may be incomplete (for example, still downloading or cut short) or damaged.';
  try {
    let readable = false;
    try {
      readable = await input.canRead();
    } catch {
      readable = false;
    }
    if (!readable) {
      if (READABLE_EXT.includes(ext)) throw new ProbeError(damaged);
      throw new ProbeError(
        hint === 'video'
          ? `${ext ? ext.toUpperCase() + ' files aren’t' : 'This video format isn’t'} supported in the browser. Convert it to MP4 (H.264) or WebM and import again.`
          : `${ext ? ext.toUpperCase() + ' files aren’t' : 'This audio format isn’t'} supported in the browser. Convert it to MP3, WAV, M4A, or FLAC and import again.`,
      );
    }
    const warnings: string[] = [];
    const vTrack = await input.getPrimaryVideoTrack();
    const aTrack = await input.getPrimaryAudioTrack();
    let video: AssetVideoInfo | undefined;
    let audio: Omit<AssetAudioInfo, 'conformed'> | undefined;

    if (vTrack) {
      const info = await probeVideoTrack(vTrack);
      const decodable = await vTrack.canDecode().catch(() => false);
      if (!decodable) {
        throw new ProbeError(
          `This browser can't decode ${codecLabel(info.codec)} video. Try Chrome or Edge, or convert the file to H.264 MP4.`,
        );
      }
      video = info;
    }
    if (aTrack) {
      const info = await probeAudioTrack(aTrack);
      const decodable = await aTrack.canDecode().catch(() => false);
      if (decodable) audio = info;
      else warnings.push(`Audio (${codecLabel(info.codec)}) can't be decoded in this browser and will be silent.`);
    }
    if (!video && !audio) {
      throw new ProbeError(aTrack ? 'The audio in this file uses a codec this browser cannot decode.' : vTrack ? 'No playable video or audio was found in this file.' : damaged);
    }
    let duration = 0;
    try {
      duration = await input.computeDuration();
    } catch {
      duration = (await input.getDurationFromMetadata().catch(() => null)) ?? 0;
    }
    if (!isFinite(duration) || duration <= 0) throw new ProbeError('Could not determine the duration of this file. It may be damaged.');
    return { kind: video ? 'video' : 'audio', duration, video, audio, warnings };
  } catch (e) {
    if (e instanceof ProbeError) throw e;
    throw new ProbeError(`The file could not be read. It may be damaged or incomplete. (${(e as Error).message ?? e})`);
  } finally {
    input.dispose();
  }
}

/** Decode an image; returns a bitmap (caller closes) and its size. */
export async function decodeImage(file: Blob, maxDim = 8192): Promise<ImageBitmap> {
  const isSvg = file.type === 'image/svg+xml' || (file instanceof File && extOf(file.name) === 'svg');
  if (isSvg) return rasterizeSvg(file, 2048);
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'premultiply' });
  } catch {
    const ext = file instanceof File ? extOf(file.name) : '';
    if (ext === 'heic' || ext === 'heif') throw new ProbeError('HEIC photos are not supported by this browser. Export them as JPEG and import again.');
    throw new ProbeError('This image could not be decoded. It may be damaged or in an unsupported format.');
  }
  if (bmp.width > maxDim || bmp.height > maxDim) {
    const s = maxDim / Math.max(bmp.width, bmp.height);
    const resized = await createImageBitmap(bmp, {
      resizeWidth: Math.round(bmp.width * s),
      resizeHeight: Math.round(bmp.height * s),
      resizeQuality: 'high',
    });
    bmp.close();
    return resized;
  }
  return bmp;
}

/** SVGs are rasterized once at import (main thread only: needs an <img>). */
async function rasterizeSvg(file: Blob, maxDim: number): Promise<ImageBitmap> {
  if (typeof document === 'undefined') throw new ProbeError('SVG must be rasterized on the main thread.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || 1024;
    let h = img.naturalHeight || 1024;
    const s = maxDim / Math.max(w, h);
    w = Math.round(w * s);
    h = Math.round(h * s);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.transferToImageBitmap();
  } catch {
    throw new ProbeError('This SVG could not be rendered.');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Encode a bitmap to PNG (used to store rasterized SVGs). */
export async function bitmapToPng(bmp: ImageBitmap): Promise<Blob> {
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}
