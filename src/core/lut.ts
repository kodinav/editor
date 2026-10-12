import { uid } from './ids';
import type { Clip, Lut, Project } from './types';

/**
 * 3D colour lookup tables (.cube files, as exported by Resolve, Premiere,
 * Photoshop and camera makers). A LUT is stored inside the project, at most
 * 33 points per side and 16 bits per value, so it travels with the project
 * and reaches the export worker without any extra plumbing.
 */

export const MAX_LUT_SIZE = 33;
const MAX_FILE_BYTES = 24 * 1024 * 1024;

export class LutError extends Error {}

export interface ParsedLut {
  title: string;
  size: number;
  /** size³ RGB triples in 0..1, red changing fastest (the .cube order). */
  values: Float32Array;
}

export function parseCube(text: string): ParsedLut {
  if (text.length > MAX_FILE_BYTES) throw new LutError('This LUT file is too large.');
  let size = 0;
  let title = '';
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  let values: Float32Array | null = null;
  let n = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const first = line.charCodeAt(0);
    const isNumber = (first >= 48 && first <= 57) || first === 45 || first === 46 || first === 43;
    if (!isNumber) {
      const [key, ...rest] = line.split(/\s+/);
      const k = key.toUpperCase();
      if (k === 'TITLE') title = rest.join(' ').replace(/^"|"$/g, '');
      else if (k === 'LUT_1D_SIZE') throw new LutError('This is a 1D LUT. Only 3D LUTs (.cube with LUT_3D_SIZE) are supported.');
      else if (k === 'LUT_3D_SIZE') {
        size = parseInt(rest[0], 10);
        if (!Number.isInteger(size) || size < 2 || size > 129) throw new LutError('This LUT has an unsupported size.');
        values = new Float32Array(size * size * size * 3);
      } else if (k === 'DOMAIN_MIN') min = rest.slice(0, 3).map(Number);
      else if (k === 'DOMAIN_MAX') max = rest.slice(0, 3).map(Number);
      continue;
    }
    if (!values) throw new LutError('This file is missing its LUT_3D_SIZE line.');
    if (n >= values.length) throw new LutError('This LUT has more entries than its size says.');
    const parts = line.split(/\s+/);
    for (let c = 0; c < 3; c++) {
      const v = parseFloat(parts[c]);
      if (!Number.isFinite(v)) throw new LutError('This LUT contains a line that isn’t three numbers.');
      values[n++] = v;
    }
  }
  if (!values || !size) throw new LutError('This doesn’t look like a .cube LUT file.');
  if (n !== values.length) throw new LutError(`This LUT is incomplete: expected ${values.length / 3} entries, found ${Math.floor(n / 3)}.`);
  if (min.some((v, i) => !Number.isFinite(v) || !Number.isFinite(max[i]) || max[i] <= v)) throw new LutError('This LUT has an invalid input range.');
  if (min.some((v) => v !== 0) || max.some((v) => v !== 1)) {
    throw new LutError('This LUT expects input outside 0–1 (a scene-linear or HDR LUT), which isn’t supported.');
  }
  return { title, size, values };
}

/** Trilinear lookup in a red-fastest table. */
export function sampleLut(values: Float32Array, size: number, r: number, g: number, b: number, out: number[] | Float32Array = [0, 0, 0], at = 0) {
  const m = size - 1;
  const fx = Math.min(1, Math.max(0, r)) * m;
  const fy = Math.min(1, Math.max(0, g)) * m;
  const fz = Math.min(1, Math.max(0, b)) * m;
  const x0 = Math.min(m - 1, Math.floor(fx));
  const y0 = Math.min(m - 1, Math.floor(fy));
  const z0 = Math.min(m - 1, Math.floor(fz));
  const tx = fx - x0;
  const ty = fy - y0;
  const tz = fz - z0;
  for (let c = 0; c < 3; c++) {
    const v = (x: number, y: number, z: number) => values[((z * size + y) * size + x) * 3 + c];
    const c00 = v(x0, y0, z0) * (1 - tx) + v(x0 + 1, y0, z0) * tx;
    const c10 = v(x0, y0 + 1, z0) * (1 - tx) + v(x0 + 1, y0 + 1, z0) * tx;
    const c01 = v(x0, y0, z0 + 1) * (1 - tx) + v(x0 + 1, y0, z0 + 1) * tx;
    const c11 = v(x0, y0 + 1, z0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1, z0 + 1) * tx;
    out[at + c] = (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  }
  return out;
}

/** Bring a LUT down to at most MAX_LUT_SIZE points per side. */
function fit(l: ParsedLut): ParsedLut {
  if (l.size <= MAX_LUT_SIZE) return l;
  const size = MAX_LUT_SIZE;
  const values = new Float32Array(size * size * size * 3);
  let i = 0;
  for (let z = 0; z < size; z++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++, i += 3) sampleLut(l.values, l.size, x / (size - 1), y / (size - 1), z / (size - 1), values, i);
  return { ...l, size, values };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Stored values cover -0.25..1.75 so LUTs that overshoot slightly keep their shape. */
const LO = -0.25;
const SPAN = 2;

export function lutDataLength(size: number): number {
  return Math.ceil((size * size * size * 3 * 2) / 3) * 4;
}

export function makeLut(name: string, parsed: ParsedLut): Lut {
  const l = fit(parsed);
  const bytes = new Uint8Array(l.values.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < l.values.length; i++) view.setUint16(i * 2, Math.round(Math.min(1, Math.max(0, (l.values[i] - LO) / SPAN)) * 65535), true);
  return { id: uid('lut'), name: (l.title || name).slice(0, 120), size: l.size, data: toBase64(bytes) };
}

/** The table as floats (red fastest), or null if the stored data is damaged. */
export function lutValues(lut: Lut): Float32Array | null {
  try {
    const bytes = fromBase64(lut.data);
    const n = lut.size * lut.size * lut.size * 3;
    if (bytes.length !== n * 2) return null;
    const view = new DataView(bytes.buffer);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = (view.getUint16(i * 2, true) / 65535) * SPAN + LO;
    return out;
  } catch {
    return null;
  }
}

/** LUT ids used by any effect in the project. */
export function usedLuts(clips: Record<string, Clip>): Set<string> {
  const used = new Set<string>();
  for (const c of Object.values(clips)) {
    if (!('effects' in c)) continue;
    for (const fx of c.effects) if (fx.type === 'lut' && typeof fx.params.lut === 'string' && fx.params.lut) used.add(fx.params.lut);
  }
  return used;
}

/** Drop LUTs that no effect refers to. */
export function pruneLuts(p: Pick<Project, 'luts' | 'clips'>) {
  if (!p.luts) return;
  const used = usedLuts(p.clips);
  for (const id of Object.keys(p.luts)) if (!used.has(id)) delete p.luts[id];
  if (!Object.keys(p.luts).length) delete p.luts;
}
