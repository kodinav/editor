import type { Asset, Project } from '@/core/types';
import { registerCustomFont } from '@/engine/fonts';
import { getPeaks, getThumbs, putThumbs, type Peaks, type ThumbSprite } from '@/storage/db';
import { makeImageThumb } from './imageThumb';
import { AnimatedImage } from './animatedImage';
import { DIRS, getFile } from '@/storage/opfs';
import { PcmSource } from './pcm';
import { decodeImage } from './probe';

/**
 * Runtime (non-serializable) state for assets on the main thread: the File
 * backing each asset, decoded still images, conformed-audio readers,
 * thumbnails and waveform peaks. UI components subscribe for changes.
 */

export interface AssetProgress {
  stage: 'copy' | 'audio' | 'thumbs' | 'probe';
  value: number;
}

export interface LoadedThumbs {
  meta: ThumbSprite;
  bitmap: ImageBitmap;
}

type Listener = () => void;

/** Longest side of decoded stills (enough for 4K output with some zoom headroom). */
export const MAX_IMAGE_DIM = 4096;
const IMAGE_BUDGET = 512 * 1024 * 1024;
const ANIMATION_BUDGET = 384 * 1024 * 1024;

class MediaRegistry {
  private files = new Map<string, File>();
  /** Decoded stills, LRU-bounded so a bin full of photos can't exhaust memory. */
  private images = new Map<string, { bmp: ImageBitmap; bytes: number; used: number }>();
  private imageBytes = 0;
  private animations = new Map<string, AnimatedImage>();
  private animationLoads = new Map<string, Promise<void>>();
  private useCounter = 0;
  private imageLoads = new Map<string, Promise<void>>();
  private pcm = new Map<string, PcmSource>();
  private thumbs = new Map<string, LoadedThumbs | null>();
  private thumbLoads = new Map<string, Promise<void>>();
  private peaks = new Map<string, Peaks | null>();
  private peakLoads = new Map<string, Promise<void>>();
  private progress = new Map<string, AssetProgress>();
  private listeners = new Set<Listener>();
  private assetMeta = new Map<string, Asset>();
  version = 0;

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getVersion = () => this.version;

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  /** Bind runtime resources for a freshly opened project. Returns ids of assets whose media is missing. */
  async attachProject(p: Project): Promise<{ missing: string[]; needsConform: string[] }> {
    const missing: string[] = [];
    const needsConform: string[] = [];
    await Promise.all(
      Object.values(p.assets).map(async (a) => {
        this.assetMeta.set(a.id, a);
        if (!this.files.has(a.id)) {
          const f = a.stored ? await getFile(DIRS.media, a.id) : null;
          if (f) this.files.set(a.id, new File([f], a.name, { type: a.mimeType, lastModified: a.lastModified }));
        }
        if (!this.files.has(a.id)) {
          missing.push(a.id);
          return;
        }
        if (a.kind === 'font' && a.font) {
          const buf = await this.files.get(a.id)!.arrayBuffer();
          await registerCustomFont(a.font.family, buf);
        }
        if (a.audio) {
          const ok = a.audio.conformed && (await this.openPcm(a));
          if (!ok) needsConform.push(a.id);
        }
      }),
    );
    this.emit();
    return { missing, needsConform };
  }

  async openPcm(a: Asset): Promise<boolean> {
    if (!a.audio) return false;
    const f = await getFile(DIRS.pcm, a.id + '.pcm');
    if (!f || f.size === 0) return false;
    this.pcm.get(a.id)?.dispose();
    const channels = a.audio.channels >= 2 ? 2 : 1;
    this.pcm.set(a.id, new PcmSource(a.id, f, a.audio.sampleRate, channels));
    if (a.audio.denoise) {
      const nr = await getFile(DIRS.pcm, a.id + '.nr.pcm');
      if (nr && nr.size > 0) this.setPcmVariant(a, 'nr', nr);
    }
    this.emit();
    return true;
  }

  /** Register a processed variant of an asset's audio (e.g. noise-reduced). */
  setPcmVariant(a: Asset, variant: 'nr', data: Blob | ArrayBuffer) {
    if (!a.audio) return;
    const key = `${a.id}:${variant}`;
    this.pcm.get(key)?.dispose();
    const blob = data instanceof Blob ? data : new Blob([data]);
    this.pcm.set(key, new PcmSource(key, blob, a.audio.sampleRate, a.audio.channels >= 2 ? 2 : 1));
    this.emit();
  }

  /** Forget a variant (before it's rebuilt), so playback uses the original audio meanwhile. */
  dropPcmVariant(id: string, variant: 'nr') {
    const key = `${id}:${variant}`;
    this.pcm.get(key)?.dispose();
    if (this.pcm.delete(key)) this.emit();
  }

  /** Conformed audio kept in memory (OPFS unavailable, e.g. private browsing). Lasts for this session. */
  setMemoryPcm(a: Asset, buffer: ArrayBuffer) {
    if (!a.audio) return;
    this.pcm.get(a.id)?.dispose();
    const channels = a.audio.channels >= 2 ? 2 : 1;
    this.pcm.set(a.id, new PcmSource(a.id, new Blob([buffer]), a.audio.sampleRate, channels));
    this.emit();
  }

  /** The bytes behind an asset's conformed audio (for the export worker). */
  getPcmBlob(id: string, variant?: 'nr'): Blob | undefined {
    return this.pcm.get(variant ? `${id}:${variant}` : id)?.blob;
  }

  setMeta(a: Asset) {
    this.assetMeta.set(a.id, a);
  }

  getFile(id: string): File | undefined {
    return this.files.get(id);
  }

  setFile(id: string, f: File) {
    this.files.set(id, f);
    // A new file invalidates decoded caches.
    this.dropImage(id);
    this.emit();
  }

  private dropAnimation(id: string) {
    this.animations.get(id)?.close();
    this.animations.delete(id);
    this.animationLoads.delete(id);
  }

  private dropImage(id: string) {
    this.dropAnimation(id);
    const e = this.images.get(id);
    if (e) {
      e.bmp.close();
      this.imageBytes -= e.bytes;
      this.images.delete(id);
    }
    this.imageLoads.delete(id);
  }

  private storeImage(id: string, bmp: ImageBitmap) {
    this.dropImage(id);
    const bytes = bmp.width * bmp.height * 4;
    this.images.set(id, { bmp, bytes, used: ++this.useCounter });
    this.imageBytes += bytes;
    this.imageLoads.set(id, Promise.resolve());
    // Evict least-recently-used stills beyond the budget (they re-decode on demand).
    if (this.imageBytes > IMAGE_BUDGET) {
      const lru = [...this.images.entries()].filter(([k]) => k !== id).sort((a, b) => a[1].used - b[1].used);
      for (const [k] of lru) {
        if (this.imageBytes <= IMAGE_BUDGET) break;
        this.dropImage(k);
      }
    }
  }

  hasFile(id: string): boolean {
    return this.files.has(id);
  }

  getPcm = (id: string, variant?: 'nr'): PcmSource | undefined => this.pcm.get(variant ? `${id}:${variant}` : id);

  /** Decoded still image, or the frame of an animated image at `time` (sync); kicks off loading if needed. */
  image = (id: string, time = 0): ImageBitmap | null => {
    if (this.assetMeta.get(id)?.image?.animated) {
      const anim = this.animations.get(id);
      if (anim) return anim.frameAt(time);
      this.loadAnimation(id);
      // Show the first frame while the animation decodes.
    }
    const e = this.images.get(id);
    if (e) {
      e.used = ++this.useCounter;
      return e.bmp;
    }
    this.loadImage(id);
    return null;
  };

  loadImage(id: string): Promise<void> {
    let p = this.imageLoads.get(id);
    if (p) return p;
    const f = this.files.get(id);
    if (!f) return Promise.resolve();
    p = decodeImage(f, MAX_IMAGE_DIM)
      .then((bmp) => {
        this.storeImage(id, bmp);
        this.emit();
      })
      .catch((e) => console.warn('Image decode failed', id, e));
    this.imageLoads.set(id, p);
    return p;
  }

  private loadAnimation(id: string) {
    if (this.animationLoads.has(id)) return;
    const f = this.files.get(id);
    if (!f) return;
    this.animationLoads.set(
      id,
      AnimatedImage.decode(f)
        .then((anim) => {
          if (!anim) return;
          // Bound memory: drop the least recently added animation beyond the budget.
          this.animations.set(id, anim);
          let total = [...this.animations.values()].reduce((n, a) => n + a.bytes, 0);
          for (const [k, a] of this.animations) {
            if (total <= ANIMATION_BUDGET || k === id) continue;
            a.close();
            this.animations.delete(k);
            this.animationLoads.delete(k);
            total -= a.bytes;
          }
          this.emit();
        })
        .catch((e) => console.warn('Animated image decode failed', id, e)),
    );
  }

  setImage(id: string, bmp: ImageBitmap) {
    this.storeImage(id, bmp);
    this.emit();
  }

  getThumbs(id: string): LoadedThumbs | null {
    const t = this.thumbs.get(id);
    if (t !== undefined) return t;
    if (!this.thumbLoads.has(id)) {
      this.thumbLoads.set(
        id,
        getThumbs(id).then(async (meta) => {
          if (!meta && this.assetMeta.get(id)?.kind === 'image' && this.files.has(id)) {
            // Projects from before image thumbnails existed: make one now.
            try {
              const full = await decodeImage(this.files.get(id)!, MAX_IMAGE_DIM);
              meta = await makeImageThumb(id, full);
              full.close();
              await putThumbs(meta);
            } catch {
              meta = undefined;
            }
          }
          if (!meta) {
            this.thumbs.set(id, null);
            return;
          }
          const bitmap = await createImageBitmap(meta.blob);
          this.thumbs.set(id, { meta, bitmap });
          this.emit();
        }),
      );
    }
    return null;
  }

  setThumbs(id: string, meta: ThumbSprite) {
    createImageBitmap(meta.blob).then((bitmap) => {
      this.thumbs.get(id)?.bitmap.close();
      this.thumbs.set(id, { meta, bitmap });
      this.thumbLoads.set(id, Promise.resolve());
      this.emit();
    });
  }

  getPeaks(id: string): Peaks | null {
    const p = this.peaks.get(id);
    if (p !== undefined) return p;
    if (!this.peakLoads.has(id)) {
      this.peakLoads.set(
        id,
        getPeaks(id).then((pk) => {
          this.peaks.set(id, pk ?? null);
          this.emit();
        }),
      );
    }
    return null;
  }

  setPeaks(id: string, pk: Peaks) {
    this.peaks.set(id, pk);
    this.peakLoads.set(id, Promise.resolve());
    this.emit();
  }

  getProgress(id: string): AssetProgress | undefined {
    return this.progress.get(id);
  }

  setProgress(id: string, p: AssetProgress | null) {
    if (p) this.progress.set(id, p);
    else this.progress.delete(id);
    this.emit();
  }

  forget(id: string) {
    this.files.delete(id);
    this.dropImage(id);
    this.pcm.get(id)?.dispose();
    this.pcm.delete(id);
    this.pcm.get(`${id}:nr`)?.dispose();
    this.pcm.delete(`${id}:nr`);
    this.thumbs.get(id)?.bitmap.close();
    this.thumbs.delete(id);
    this.thumbLoads.delete(id);
    this.peaks.delete(id);
    this.peakLoads.delete(id);
    this.progress.delete(id);
    this.emit();
  }

  /** Drop everything (when switching projects). Files stay in OPFS. */
  reset() {
    for (const id of [...this.files.keys(), ...this.images.keys(), ...this.pcm.keys()]) this.forget(id);
    this.thumbs.clear();
    this.peaks.clear();
    this.assetMeta.clear();
    this.emit();
  }
}

export const media = new MediaRegistry();
