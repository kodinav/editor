import { describe, expect, it } from 'vitest';
import { createEffect } from '../../src/core/effects';
import { evaluateFrame } from '../../src/core/evaluate';
import { audibleSegments, audioSourceTime, clipGainAt, clipPanAt } from '../../src/core/audio';
import { upsertKeyframe } from '../../src/core/keyframes';
import {
  createAdjustmentClip,
  createAudioClip,
  createCaptionClip,
  createProject,
  createShapeClip,
  createTextClip,
  createImageClip,
  createVideoClip,
  createTrack,
  projectDuration,
} from '../../src/core/project';
import { parseProject, ProjectValidationError } from '../../src/core/schema';
import type { Asset, Project } from '../../src/core/types';
import { layoutTracks } from '../../src/ui/timeline/layout';

/**
 * Project files are untrusted input. Whatever parseProject accepts must be
 * safe for the rest of the app: no exceptions, no runaway loops, no NaN
 * leaking into rendering or audio.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function asset(id: string, kind: Asset['kind'], duration: number): Asset {
  return {
    id,
    kind,
    name: id,
    mimeType: '',
    size: 1,
    lastModified: 0,
    duration,
    status: 'ready',
    stored: true,
    createdAt: 0,
    video: kind === 'video' ? { width: 1920, height: 1080, rotation: 0, fps: 30, codec: 'avc', hasAlpha: false } : undefined,
    audio: kind === 'video' || kind === 'audio' ? { sampleRate: 48000, channels: 2, codec: 'aac', conformed: true } : undefined,
    image: kind === 'image' ? { width: 100, height: 100 } : undefined,
  };
}

/** A project that uses every kind of clip and most features. */
function richProject(): Project {
  const p = createProject('rich');
  p.assets.V1 = asset('V1', 'video', 12);
  p.assets.A1 = asset('A1', 'audio', 30);
  p.assets.I1 = asset('I1', 'image', 0);
  const caps = createTrack('caption', 'Captions');
  p.tracks.unshift(caps);
  const [v1] = p.tracks.filter((t) => t.kind === 'video');
  const [a1] = p.tracks.filter((t) => t.kind === 'audio');
  const vid = createVideoClip(p.assets.V1, { trackId: v1.id, start: 0, duration: 6 });
  vid.effects.push(createEffect('blur'), createEffect('chromaKey'));
  vid.transitionOut = { type: 'crossfade', duration: 0.5 };
  upsertKeyframe(vid, 'transform.x', 0, 0);
  upsertKeyframe(vid, 'transform.x', 2, 300);
  upsertKeyframe(vid, 'opacity', 1, 0.5);
  const img = createImageClip(p.assets.I1, { trackId: v1.id, start: 6, duration: 3 });
  img.animIn = { preset: 'pop', duration: 0.5 };
  const text = createTextClip({ trackId: v1.id, start: 9, duration: 2 }, 'Hello');
  const shape = createShapeClip({ trackId: v1.id, start: 11, duration: 2 }, 'rectangle', { width: 300, height: 200, fill: '#ff0000', fill2: null, gradientAngle: 0, radius: 10 });
  const adj = createAdjustmentClip({ trackId: v1.id, start: 13, duration: 2 });
  adj.effects.push(createEffect('vignette'));
  const aud = createAudioClip(p.assets.A1, { trackId: a1.id, start: 0, duration: 10 });
  aud.fadeIn = 1;
  upsertKeyframe(aud, 'volume', 2, 0.5);
  const cap = createCaptionClip({ trackId: caps.id, start: 1, duration: 2 }, 'Caption text');
  cap.words = [
    { text: 'Caption', start: 0, end: 0.8 },
    { text: 'text', start: 0.8, end: 1.6 },
  ];
  for (const c of [vid, img, text, shape, adj, aud, cap]) p.clips[c.id] = c;
  p.markers.push({ id: 'm1', t: 2, label: 'Marker', color: '#ff0' });
  p.inPoint = 1;
  p.outPoint = 8;
  return p;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Every path into a JSON value (objects and arrays included). */
function paths(v: Json, prefix: (string | number)[] = [], out: (string | number)[][] = []): (string | number)[][] {
  if (prefix.length) out.push(prefix);
  if (Array.isArray(v)) v.forEach((x, i) => paths(x, [...prefix, i], out));
  else if (v && typeof v === 'object') for (const k of Object.keys(v)) paths(v[k], [...prefix, k], out);
  return out;
}

const GARBAGE: Json[] = [null, -1, 0, 1e300, -1e300, 1e-300, 7.5, 'x', '', true, false, [], {}, [1, 2], { a: 1 }, 'NaN', -0.0001, 2 ** 31, '<img src=x onerror=alert(1)>'];

function corrupt(doc: Json, r: () => number, edits: number): Json {
  const copy = JSON.parse(JSON.stringify(doc)) as Json;
  for (let i = 0; i < edits; i++) {
    const all = paths(copy);
    const path = all[Math.floor(r() * all.length)];
    let parent = copy as Record<string | number, Json>;
    for (const k of path.slice(0, -1)) parent = parent[k] as Record<string | number, Json>;
    const key = path[path.length - 1];
    if (r() < 0.15 && !Array.isArray(parent)) delete parent[key];
    else parent[key] = GARBAGE[Math.floor(r() * GARBAGE.length)];
  }
  return copy;
}

function assertFinite(v: unknown, where: string, seen = new Set<unknown>()): void {
  if (typeof v === 'number') {
    expect(Number.isFinite(v), `${where} is ${v}`).toBe(true);
    return;
  }
  if (!v || typeof v !== 'object' || seen.has(v)) return;
  seen.add(v);
  for (const [k, x] of Object.entries(v)) assertFinite(x, `${where}.${k}`, seen);
}

/** Exercise what the editor does with a freshly opened project. */
function useProject(p: Project) {
  const dur = projectDuration(p);
  expect(Number.isFinite(dur)).toBe(true);
  // Long enough for real work, short enough that rulers, zoom and loops stay bounded.
  expect(dur).toBeLessThanOrEqual(1e6);
  const layout = layoutTracks(p);
  assertFinite(layout.total, 'layout.total');
  for (const row of layout.rows) assertFinite([row.top, row.height], 'layout.row');
  for (const t of [0, 0.5, 1.7, 3, 5.9, 6.2, 9.5, 12, 14, dur / 2, Math.max(0, dur - 0.01)]) {
    const frame = evaluateFrame(p, t);
    assertFinite(frame, `frame@${t}`);
  }
  const segs = audibleSegments(p, 0, Math.min(dur, 60));
  for (const s of segs) {
    for (const t of [s.start, (s.start + s.end) / 2]) {
      assertFinite([clipGainAt(p, s, t), clipPanAt(s, t), audioSourceTime(s, t)], 'audio');
    }
  }
}

describe('untrusted project files', () => {
  it('valid projects pass through unchanged', () => {
    const json = JSON.parse(JSON.stringify(richProject()));
    const parsed = parseProject(json);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(json);
    // And repairing is idempotent.
    expect(parseProject(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    useProject(parsed);
  });

  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`corrupted documents are rejected or made safe (seed ${seed})`, () => {
      const r = rng(seed);
      const base = JSON.parse(JSON.stringify(richProject())) as Json;
      for (let i = 0; i < 250; i++) {
        const doc = corrupt(base, r, 1 + Math.floor(r() * 3));
        let p: Project;
        try {
          p = parseProject(doc);
        } catch (e) {
          if (e instanceof ProjectValidationError) continue;
          throw new Error(`parseProject crashed (seed ${seed}, case ${i}): ${(e as Error).message}`);
        }
        try {
          useProject(p);
        } catch (e) {
          throw new Error(`accepted project broke the editor (seed ${seed}, case ${i}): ${(e as Error).message}\n${JSON.stringify(doc).slice(0, 4000)}`);
        }
      }
    });
  }
});

describe('looks', () => {
  it('effects added by a look stay marked after reopening (so the next look replaces them)', () => {
    const p = richProject();
    const vid = Object.values(p.clips).find((c) => c.type === 'video') as { effects: { look?: boolean; params: Record<string, unknown> }[] };
    vid.effects[0].look = true;
    vid.effects[1].params.__filter = true; // how older projects marked it
    const back = parseProject(JSON.parse(JSON.stringify(p)));
    const fx = (Object.values(back.clips).find((c) => c.type === 'video') as unknown as { effects: { look?: boolean; params: Record<string, unknown> }[] }).effects;
    expect(fx.map((e) => e.look === true)).toEqual([true, true]);
    expect(fx[1].params.__filter).toBeUndefined();
  });
});

describe('schema versions', () => {
  it('refuses projects saved by a newer version instead of stripping what it does not know', () => {
    const doc = JSON.parse(JSON.stringify(richProject()));
    doc.schemaVersion = 999;
    expect(() => parseProject(doc)).toThrow(/newer version/);
  });
});
