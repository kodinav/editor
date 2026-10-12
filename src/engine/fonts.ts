import { BUNDLED_FONTS, type FontFaceEntry, type FontFamilyEntry } from './fontManifest';

/**
 * Font loading for text rendering. Works in the window and in workers (both
 * expose a FontFaceSet as `self.fonts`). Fonts are self-hosted, so rendering
 * never depends on a third-party CDN and preview/export use identical glyphs.
 *
 * Each family comes in script subsets (Latin, Cyrillic, Greek, Vietnamese,
 * and for some families Arabic, Hebrew or Devanagari). A subset is fetched
 * only when a text actually contains its characters.
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

/** Custom (user-imported) fonts: family -> font bytes, and the faces added for them. */
const customFonts = new Map<string, ArrayBuffer>();
const customFaces = new Map<string, FontFace>();

export function onFontLoaded(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function findFamily(family: string): FontFamilyEntry | undefined {
  return BUNDLED_FONTS.find((f) => f.family === family);
}

/**
 * The face to load for a bundled family: the closest weight first (so italic
 * never makes a bold title regular), then its italic if the family has one.
 * Families without italics are slanted by the browser (text.ts always asks
 * for italic when it's on).
 */
export function resolveWeight(family: string, weight: number, italic: boolean): { weight: number; italic: boolean } {
  const fam = findFamily(family);
  if (!fam) return { weight, italic };
  let best = fam.faces[0].weight;
  for (const f of fam.faces) if (Math.abs(f.weight - weight) < Math.abs(best - weight)) best = f.weight;
  return { weight: best, italic: italic && fam.faces.some((f) => f.weight === best && f.italic) };
}

function key(family: string, weight: number, italic: boolean) {
  return `${family}|${weight}|${italic ? 1 : 0}`;
}

/** One subset file of a bundled face, registered with the browser but fetched on demand. */
interface Subset {
  entry: FontFaceEntry;
  ranges: [number, number][];
  face: FontFace | null;
  state: 'idle' | 'loading' | 'loaded' | 'failed';
  promise: Promise<void> | null;
}
const subsets = new Map<string, Subset[]>();

function parseRanges(s: string): [number, number][] {
  return s.split(',').flatMap((part): [number, number][] => {
    const m = /^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i.exec(part.trim());
    if (!m) return [];
    if (m[1].includes('?')) return [[parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'F'), 16)]];
    const a = parseInt(m[1], 16);
    return [[a, m[2] ? parseInt(m[2], 16) : a]];
  });
}

function subsetsFor(fam: FontFamilyEntry, weight: number, italic: boolean): Subset[] {
  const k = key(fam.family, weight, italic);
  let list = subsets.get(k);
  if (!list) {
    list = fam.faces.filter((f) => f.weight === weight && f.italic === italic).map((entry) => ({ entry, ranges: parseRanges(entry.unicodeRange), face: null, state: 'idle', promise: null }));
    subsets.set(k, list);
  }
  return list;
}

/** The subsets a text needs: Latin always (its metrics set the line height), plus any whose range it touches. */
function needed(list: Subset[], text: string): Subset[] {
  if (list.length <= 1) return list;
  const hit = new Set<Subset>([list[0]]);
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) continue;
    for (const s of list) {
      if (hit.has(s)) continue;
      if (s.ranges.some(([a, b]) => cp >= a && cp <= b)) hit.add(s);
    }
  }
  return [...hit];
}

function loadSubset(family: string, s: Subset): Promise<void> {
  if (s.promise) return s.promise;
  s.state = 'loading';
  s.promise = (async () => {
    const set = fontSet();
    if (!set) return;
    const base = typeof location !== 'undefined' ? location.href : undefined;
    const url = new URL(s.entry.url, base).href;
    const face = new FontFace(family, `url(${JSON.stringify(url)})`, {
      weight: String(s.entry.weight),
      style: s.entry.italic ? 'italic' : 'normal',
      unicodeRange: s.entry.unicodeRange,
    });
    await face.load();
    set.add(face);
    s.face = face;
    s.state = 'loaded';
    listeners.forEach((l) => l());
  })().catch((e) => {
    s.state = 'failed';
    console.warn('Font failed to load', family, s.entry.subset, e);
    listeners.forEach((l) => l());
  });
  return s.promise;
}

/** Whether every face this text needs is loaded. Pass the text so non-Latin subsets are counted. */
export function isFontReady(family: string, weight: number, italic: boolean, text = ''): boolean {
  if (SYSTEM_FONTS.includes(family)) return true;
  if (customFonts.has(family)) return ready.has(key(family, 0, false));
  const fam = findFamily(family);
  if (!fam) return true;
  const r = resolveWeight(family, weight, italic);
  return needed(subsetsFor(fam, r.weight, r.italic), text).every((s) => s.state === 'loaded' || s.state === 'failed');
}

/** Load (once) the faces needed to draw `text` in this family/weight/style. */
export function ensureFont(family: string, weight: number, italic: boolean, text = ''): Promise<void> {
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
        if (!customFonts.has(family)) return; // unregistered while loading
        set.add(face);
        customFaces.set(family, face);
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
  const todo = needed(subsetsFor(fam, r.weight, r.italic), text).filter((s) => s.state !== 'loaded' && s.state !== 'failed');
  if (!todo.length) return Promise.resolve();
  return Promise.all(todo.map((s) => loadSubset(family, s))).then(() => {});
}

export function registerCustomFont(family: string, data: ArrayBuffer): Promise<void> {
  customFonts.set(family, data);
  return ensureFont(family, 400, false);
}

/** Forget a custom font (its project closed or the font was removed), so preview matches export. */
export function unregisterCustomFont(family: string) {
  if (!customFonts.delete(family)) return;
  const face = customFaces.get(family);
  if (face) fontSet()?.delete(face);
  customFaces.delete(family);
  const k = key(family, 0, false);
  loaded.delete(k);
  ready.delete(k);
  listeners.forEach((l) => l());
}

export function customFontFamilies(): string[] {
  return [...customFonts.keys()];
}

export function cssFontFamily(family: string): string {
  const fam = findFamily(family);
  const generic = fam?.category === 'serif' ? 'serif' : fam?.category === 'mono' ? 'monospace' : fam?.category === 'script' ? 'cursive' : 'sans-serif';
  return `"${family.replace(/"/g, '')}", ${generic}`;
}
