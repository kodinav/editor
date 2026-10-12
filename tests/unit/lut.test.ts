import { describe, expect, it } from 'vitest';
import { LutError, lutDataLength, lutValues, makeLut, MAX_LUT_SIZE, parseCube, pruneLuts, sampleLut } from '../../src/core/lut';
import { sanitizeLuts } from '../../src/core/sanitize';
import { toneCurve } from '../../src/engine/compositor';

/** A .cube whose output is f(r, g, b), red changing fastest. */
function cube(size: number, f: (r: number, g: number, b: number) => number[], header = ''): string {
  let s = `TITLE "test"\n# comment\n${header}LUT_3D_SIZE ${size}\n`;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) s += f(r / (size - 1), g / (size - 1), b / (size - 1)).map((v) => v.toFixed(6)).join(' ') + '\n';
  return s;
}

describe('.cube LUTs', () => {
  it('parses a file and keeps red as the fastest axis', () => {
    const l = parseCube(cube(3, (r, g, b) => [b, r, g]));
    expect(l.size).toBe(3);
    expect(l.title).toBe('test');
    expect(Array.from(sampleLut(l.values, 3, 1, 0, 0))).toEqual([0, 1, 0]); // red in → green out
    expect(Array.from(sampleLut(l.values, 3, 0, 0, 1))).toEqual([1, 0, 0]);
  });

  it('survives storage: 16-bit values round-trip, including slight overshoots', () => {
    const lut = makeLut('x', parseCube(cube(5, (r, g, b) => [r * 1.1 - 0.05, g * g, 1 - b])));
    expect(lut.data.length).toBe(lutDataLength(5));
    const v = lutValues(lut)!;
    const out = sampleLut(v, 5, 1, 0.5, 0.25);
    expect(out[0]).toBeCloseTo(1.05, 3);
    expect(out[1]).toBeCloseTo(0.25, 3);
    expect(out[2]).toBeCloseTo(0.75, 3);
  });

  it('shrinks big tables to the stored maximum without changing the look', () => {
    const f = (r: number, g: number, b: number) => [Math.sqrt(r), g * 0.5 + b * 0.5, b * b];
    const lut = makeLut('big', parseCube(cube(40, f)));
    expect(lut.size).toBe(MAX_LUT_SIZE);
    const out = sampleLut(lutValues(lut)!, lut.size, 0.36, 0.2, 0.7);
    const want = f(0.36, 0.2, 0.7);
    for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(want[i], 2);
  });

  it('explains files it cannot use', () => {
    expect(() => parseCube('LUT_1D_SIZE 16\n0 0 0\n')).toThrow(/1D LUT/);
    expect(() => parseCube('hello world')).toThrow(LutError);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n1 1 1\n')).toThrow(/incomplete/);
    expect(() => parseCube(cube(2, (r, g, b) => [r, g, b], 'DOMAIN_MAX 4 4 4\n'))).toThrow(/outside 0–1/);
    expect(() => parseCube(cube(2, (r, g, b) => [r, g, b]) + '0 0 0\n')).toThrow(/more entries/);
  });

  it('untrusted project data: malformed tables are dropped, unused ones pruned', () => {
    const good = makeLut('ok', parseCube(cube(2, (r, g, b) => [r, g, b])));
    const luts = sanitizeLuts({
      [good.id]: good,
      bad1: { ...good, size: 3 }, // data doesn't match the size
      bad2: { ...good, data: '<script>' },
      bad3: { ...good, size: 4096 },
      bad4: 'nope',
    })!;
    expect(Object.keys(luts)).toEqual([good.id]);
    expect(sanitizeLuts({})).toBeUndefined();
    const p = { luts: { [good.id]: good }, clips: {} };
    pruneLuts(p);
    expect(p.luts).toBeUndefined();
  });
});

describe('tone curve', () => {
  const at = (c: { y: number[]; m: number[] }, x: number) => {
    const t = Math.min(1, Math.max(0, x)) * 4;
    const i = Math.min(3, Math.floor(t));
    const f = t - i;
    const h = 0.25;
    return (2 * f ** 3 - 3 * f ** 2 + 1) * c.y[i] + (f ** 3 - 2 * f ** 2 + f) * h * c.m[i] + (-2 * f ** 3 + 3 * f ** 2) * c.y[i + 1] + (f ** 3 - f ** 2) * h * c.m[i + 1];
  };
  it('is the identity with all sliders at zero', () => {
    const c = toneCurve([0, 0, 0, 0, 0]);
    for (const x of [0, 0.1, 0.33, 0.5, 0.9, 1]) expect(at(c, x)).toBeCloseTo(x, 6);
  });
  it('never folds back, whatever the sliders say', () => {
    for (const o of [[100, -100, 100, -100, 100], [-100, 100, -100, 100, -100], [0, 80, -60, 40, 0], [100, 100, 100, 100, 100]]) {
      const c = toneCurve(o);
      let prev = -1;
      for (let x = 0; x <= 1.0001; x += 0.01) {
        const y = at(c, x);
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeLessThanOrEqual(1 + 1e-9);
        prev = y;
      }
    }
  });
});
