/**
 * Animated GIF / WebP / APNG support via WebCodecs' ImageDecoder. Frames are
 * decoded once into ImageBitmaps (downscaled if the whole animation would
 * exceed a memory budget) and looked up by time, looping. Works on the main
 * thread and in workers.
 */

const BUDGET_BYTES = 192 * 1024 * 1024;

export interface AnimationInfo {
  frames: number;
  /** Seconds for one loop. */
  duration: number;
  width: number;
  height: number;
}

export function animatedTypeFor(file: Blob & { name?: string }): string | null {
  const t = file.type;
  if (t === 'image/gif' || t === 'image/webp' || t === 'image/apng' || t === 'image/png') return t;
  const ext = (file.name ?? '').split('.').pop()?.toLowerCase();
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'png' || ext === 'apng') return 'image/png';
  return null;
}

function supported(): boolean {
  return typeof (globalThis as unknown as { ImageDecoder?: unknown }).ImageDecoder !== 'undefined';
}

/** Returns animation info if the file is an animated image this browser can decode, else null. */
export async function probeAnimation(file: Blob & { name?: string }): Promise<AnimationInfo | null> {
  const type = animatedTypeFor(file);
  if (!type || !supported()) return null;
  try {
    if (!(await ImageDecoder.isTypeSupported(type))) return null;
    const dec = new ImageDecoder({ data: await file.arrayBuffer(), type });
    try {
      await dec.tracks.ready;
      const track = dec.tracks.selectedTrack;
      if (!track || !track.animated) return null;
      await dec.completed;
      const frames = track.frameCount;
      if (frames <= 1) return null;
      let duration = 0;
      let width = 0;
      let height = 0;
      for (let i = 0; i < frames; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        duration += frameSeconds(image);
        width = image.displayWidth;
        height = image.displayHeight;
        image.close();
      }
      return { frames, duration: Math.max(duration, 0.04), width, height };
    } finally {
      dec.close();
    }
  } catch {
    return null;
  }
}

function frameSeconds(f: VideoFrame): number {
  // Browsers report 0 for "as fast as possible"; GIF players treat that as 100 ms.
  const d = (f.duration ?? 0) / 1e6;
  return d < 0.02 ? 0.1 : d;
}

export class AnimatedImage {
  private constructor(
    readonly frames: ImageBitmap[],
    /** Start time of each frame within one loop. */
    readonly starts: number[],
    readonly duration: number,
  ) {}

  static async decode(file: Blob & { name?: string }): Promise<AnimatedImage | null> {
    const type = animatedTypeFor(file);
    if (!type || !supported()) return null;
    const dec = new ImageDecoder({ data: await file.arrayBuffer(), type });
    try {
      await dec.tracks.ready;
      await dec.completed;
      const n = dec.tracks.selectedTrack?.frameCount ?? 0;
      if (n <= 1) return null;
      const frames: ImageBitmap[] = [];
      const starts: number[] = [];
      let t = 0;
      let scale = 1;
      for (let i = 0; i < n; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        if (i === 0) {
          const bytes = image.displayWidth * image.displayHeight * 4 * n;
          if (bytes > BUDGET_BYTES) scale = Math.sqrt(BUDGET_BYTES / bytes);
        }
        const bmp =
          scale < 1
            ? await createImageBitmap(image, { resizeWidth: Math.max(1, Math.round(image.displayWidth * scale)), resizeHeight: Math.max(1, Math.round(image.displayHeight * scale)), premultiplyAlpha: 'premultiply' })
            : await createImageBitmap(image, { premultiplyAlpha: 'premultiply' });
        starts.push(t);
        t += frameSeconds(image);
        image.close();
        frames.push(bmp);
      }
      return new AnimatedImage(frames, starts, t);
    } finally {
      dec.close();
    }
  }

  frameAt(time: number): ImageBitmap {
    const t = ((time % this.duration) + this.duration) % this.duration;
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid] <= t) lo = mid;
      else hi = mid - 1;
    }
    return this.frames[lo];
  }

  get bytes(): number {
    return this.frames.reduce((n, f) => n + f.width * f.height * 4, 0);
  }

  close() {
    for (const f of this.frames) f.close();
  }
}
