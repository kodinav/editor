import { BUNDLED_FONTS, type FontFamilyEntry } from './fontManifest';

/**
 * Font loading for text rendering. Works in the window and in workers (both
 * expose a FontFaceSet as `self.fonts`). Fonts are self-hosted, so rendering
 * never depends on a third-party CDN and preview/export use identical glyphs.
 */

export { BUNDLED_FONTS };

export const SYSTEM_FONTS = ['Arial', 'Helvetica', 'Georgia', 'Times New Roman', 'Courier New', 'Verdana', 'Impact'];

function fontSet(): FontFaceSet | null {
  const s = (globalThis as unknown as { fonts?: FontFaceSet }).fonts ?? (typeof document !== 'undefined' ? document.fonts : null);
  return s ?? null;
}

const loaded = new Map<string, Promise<void>>();
const ready = new Set<string>();
const listeners = new Set<() => void>();

/** Custom (user-imported) fonts: family -> font bytes. */
const customFonts = new Map<string, ArrayBuffer>();

export function onFontLoaded(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function findFamily(family: string): FontFamilyEntry | undefined {
  return BUNDLED_FONTS.find((f) => f.family === family);
}

/** Closest available weight for a bundled family. */
export function resolveWeight(family: string, weight: number, italic: boolean): { weight: number; italic: boolean } {
  const fam = findFamily(family);
  if (!fam) return { weight, italic };
  const faces = fam.faces.filter((f) => f.italic === italic);
  const pool = faces.length ? faces : fam.faces;
  let best = pool[0];
  for (const f of pool) if (Math.abs(f.weight - weight) < Math.abs(best.weight - weight)) best = f;
  return { weight: best.weight, italic: best.italic };
}

function key(family: string, weight: number, italic: boolean) {
  return `${family}|${weight}|${italic ? 1 : 0}`;
}

export function isFontReady(family: string, weight: number, italic: boolean): boolean {
  if (SYSTEM_FONTS.includes(family)) return true;
  const r = resolveWeight(family, weight, italic);
  return ready.has(key(family, r.weight, r.italic)) || (customFonts.has(family) && ready.has(key(family, 0, false)));
}

/** Load (once) the face needed for this family/weight/style. */
export function ensureFont(family: string, weight: number, italic: boolean): Promise<void> {
  if (SYSTEM_FONTS.includes(family)) return Promise.resolve();
  if (customFonts.has(family)) {
    const k = key(family, 0, false);
    let p = loaded.get(k);
    if (!p) {
      p = (async () => {
        const set = fontSet();
        if (!set) return;
        const face = new FontFace(family, customFonts.get(family)!);
        await face.load();
        set.add(face);
        ready.add(k);
        listeners.forEach((l) => l());
      })().catch((e) => console.warn('Custom font failed to load', family, e));
      loaded.set(k, p);
    }
    return p;
  }
  const fam = findFamily(family);
  if (!fam) return Promise.resolve();
  const r = resolveWeight(family, weight, italic);
  const k = key(family, r.weight, r.italic);
  let p = loaded.get(k);
  if (!p) {
    p = (async () => {
      const set = fontSet();
      if (!set) return;
      const faces = fam.faces.filter((f) => f.weight === r.weight && f.italic === r.italic);
      await Promise.all(
        faces.map(async (f) => {
          const base = typeof location !== 'undefined' ? location.href : undefined;
          const url = new URL(f.url, base).href;
          const face = new FontFace(family, `url(${JSON.stringify(url)})`, {
            weight: String(f.weight),
            style: f.italic ? 'italic' : 'normal',
            unicodeRange: f.unicodeRange,
          });
          await face.load();
          set.add(face);
        }),
      );
      ready.add(k);
      listeners.forEach((l) => l());
    })().catch((e) => console.warn('Font failed to load', family, e));
    loaded.set(k, p);
  }
  return p;
}

export function registerCustomFont(family: string, data: ArrayBuffer): Promise<void> {
  customFonts.set(family, data);
  return ensureFont(family, 400, false);
}

export function customFontFamilies(): string[] {
  return [...customFonts.keys()];
}

export function cssFontFamily(family: string): string {
  const fam = findFamily(family);
  const generic = fam?.category === 'serif' ? 'serif' : fam?.category === 'mono' ? 'monospace' : fam?.category === 'script' ? 'cursive' : 'sans-serif';
  return `"${family.replace(/"/g, '')}", ${generic}`;
}
