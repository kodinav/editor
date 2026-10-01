import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createProject, createVideoClip, createAudioClip, createTextClip, createImageClip, clipEnd } from '../../src/core/project';
import {
  addTrack,
  closeGapAt,
  deleteClips,
  detachAudio,
  duplicateClips,
  makeRoomFor,
  moveClips,
  normalize,
  pasteClips,
  setSpeed,
  splitAt,
  splitClip,
  trimEnd,
  trimStart,
  nextAdjacent,
} from '../../src/core/ops';
import { evaluateFrame } from '../../src/core/evaluate';
import { audibleSegments, clipGainAt } from '../../src/core/audio';
import type { Asset, Project } from '../../src/core/types';
import { isVisualClip } from '../../src/core/types';

/** Deterministic PRNG so failures are reproducible. */
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
    audio: kind !== 'image' ? { sampleRate: 48000, channels: 2, codec: 'aac', conformed: true } : undefined,
    image: kind === 'image' ? { width: 100, height: 100 } : undefined,
  };
}

function checkInvariants(p: Project, step: string) {
  const fps = p.settings.fps;
  const trackIds = new Set(p.tracks.map((t) => t.id));
  const byTrack = new Map<string, { s: number; e: number; id: string }[]>();
  for (const c of Object.values(p.clips)) {
    expect(trackIds.has(c.trackId), `${step}: clip on missing track`).toBe(true);
    expect(c.start, `${step}: negative start`).toBeGreaterThanOrEqual(-1e-9);
    expect(c.duration, `${step}: too short`).toBeGreaterThanOrEqual(1 / fps - 1e-6);
    expect(Number.isFinite(c.start) && Number.isFinite(c.duration), `${step}: non-finite`).toBe(true);
    if ('assetId' in c) expect(p.assets[c.assetId], `${step}: missing asset`).toBeTruthy();
    if (c.type === 'video' || c.type === 'audio') {
      expect(c.sourceIn, `${step}: sourceIn < 0`).toBeGreaterThanOrEqual(-1e-6);
      const a = p.assets[c.assetId];
      if (!(c.type === 'video' && c.freeze)) expect(c.sourceIn + c.duration * c.speed, `${step}: past media end`).toBeLessThanOrEqual(a.duration + 2 / fps);
    }
    const arr = byTrack.get(c.trackId) ?? [];
    arr.push({ s: c.start, e: clipEnd(c), id: c.id });
    byTrack.set(c.trackId, arr);
    if (isVisualClip(c) && c.transitionOut) {
      const next = nextAdjacent(p, c);
      expect(next, `${step}: dangling transition`).toBeTruthy();
      expect(c.transitionOut.duration).toBeLessThanOrEqual(Math.min(c.duration, next!.duration) + 1e-6);
    }
  }
  for (const [, arr] of byTrack) {
    arr.sort((a, b) => a.s - b.s);
    for (let i = 1; i < arr.length; i++) {
      expect(arr[i].s, `${step}: overlap on track`).toBeGreaterThanOrEqual(arr[i - 1].e - 1e-6);
    }
  }
}

describe('timeline fuzzing', () => {
  for (const seed of [1, 7, 42, 1337, 2024]) {
    it(`keeps invariants through 400 random edits (seed ${seed})`, () => {
      const r = rng(seed);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
      let p = createProject('fuzz');
      p.assets.V1 = asset('V1', 'video', 12);
      p.assets.V2 = asset('V2', 'video', 4.5);
      p.assets.A1 = asset('A1', 'audio', 30);
      p.assets.I1 = asset('I1', 'image', 0);
      const ops = [
        'addVideo', 'addAudio', 'addText', 'addImage', 'split', 'splitAt', 'move', 'moveTrack', 'moveInsert', 'trimStart', 'trimEnd',
        'delete', 'rippleDelete', 'speed', 'transition', 'duplicate', 'paste', 'closeGap', 'detach', 'addTrack',
      ] as const;
      for (let i = 0; i < 400; i++) {
        const op = pick([...ops]);
        const ids = Object.keys(p.clips);
        const id = ids.length ? pick(ids) : null;
        const t = r() * 30;
        const vTracks = p.tracks.filter((x) => x.kind === 'video');
        const aTracks = p.tracks.filter((x) => x.kind === 'audio');
        p = produce(p, (d) => {
          switch (op) {
            case 'addVideo': {
              const c = createVideoClip(d.assets[pick(['V1', 'V2'])], { trackId: pick(vTracks).id, start: Math.round(t * 30) / 30, duration: 0 });
              c.duration = Math.round(d.assets[c.assetId].duration * 30) / 30;
              d.clips[c.id] = c;
              makeRoomFor(d, [c.id], r() < 0.5 ? 'overwrite' : 'insert');
              break;
            }
            case 'addAudio': {
              const c = createAudioClip(d.assets.A1, { trackId: pick(aTracks).id, start: Math.round(t * 30) / 30, duration: Math.round((1 + r() * 10) * 30) / 30 });
              d.clips[c.id] = c;
              makeRoomFor(d, [c.id], 'overwrite');
              break;
            }
            case 'addText': {
              const c = createTextClip({ trackId: pick(vTracks).id, start: Math.round(t * 30) / 30, duration: 2 });
              d.clips[c.id] = c;
              makeRoomFor(d, [c.id], 'overwrite');
              break;
            }
            case 'addImage': {
              const c = createImageClip(d.assets.I1, { trackId: pick(vTracks).id, start: Math.round(t * 30) / 30, duration: 3 });
              d.clips[c.id] = c;
              makeRoomFor(d, [c.id], 'overwrite');
              break;
            }
            case 'split':
              if (id) splitClip(d, id, d.clips[id].start + r() * d.clips[id].duration);
              break;
            case 'splitAt':
              splitAt(d, t);
              break;
            case 'move':
              if (id) moveClips(d, { clipIds: [id], dt: (r() - 0.5) * 10, trackDelta: 0, mode: 'overwrite' });
              break;
            case 'moveTrack':
              if (id) moveClips(d, { clipIds: [id], dt: (r() - 0.5) * 4, trackDelta: pick([-1, 1, 2]), mode: 'overwrite' });
              break;
            case 'moveInsert':
              if (ids.length > 1) moveClips(d, { clipIds: [pick(ids), pick(ids)], dt: (r() - 0.5) * 6, trackDelta: 0, mode: 'insert' });
              break;
            case 'trimStart':
              if (id) trimStart(d, id, d.clips[id].start + (r() - 0.5) * 4);
              break;
            case 'trimEnd':
              if (id) trimEnd(d, id, clipEnd(d.clips[id]) + (r() - 0.5) * 4);
              break;
            case 'delete':
              if (id) deleteClips(d, [id], false);
              break;
            case 'rippleDelete':
              if (id) deleteClips(d, [id], true);
              break;
            case 'speed':
              if (id && (d.clips[id].type === 'video' || d.clips[id].type === 'audio')) setSpeed(d, id, pick([0.25, 0.5, 1, 1.5, 2, 4]));
              break;
            case 'transition':
              if (id) {
                const c = d.clips[id];
                const next = nextAdjacent(d, c);
                if (isVisualClip(c) && next && isVisualClip(next)) c.transitionOut = { type: 'crossfade', duration: 0.1 + r() * 3 };
              }
              break;
            case 'duplicate':
              if (id) duplicateClips(d, [id]);
              break;
            case 'paste':
              if (id) pasteClips(d, [JSON.parse(JSON.stringify(d.clips[id]))], t);
              break;
            case 'closeGap':
              closeGapAt(d, pick(d.tracks).id, t);
              break;
            case 'detach':
              if (id) detachAudio(d, id);
              break;
            case 'addTrack':
              if (d.tracks.length < 8) addTrack(d, pick(['video', 'audio'] as const));
              break;
          }
          normalize(d);
        });
        checkInvariants(p, `step ${i} (${op})`);
        // Rendering and mixing descriptions must be computable anywhere.
        const tt = r() * 40;
        const f = evaluateFrame(p, tt);
        for (const l of f.layers) if (l.type === 'transition') expect(l.progress).toBeGreaterThanOrEqual(0);
        for (const seg of audibleSegments(p, tt, tt + 0.5)) expect(Number.isFinite(clipGainAt(p, seg, tt + 0.1))).toBe(true);
      }
      expect(Object.keys(p.clips).length).toBeGreaterThan(0);
    });
  }
});
