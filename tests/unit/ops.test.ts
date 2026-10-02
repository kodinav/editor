import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { createProject, createVideoClip, createImageClip, createTextClip, createCaptionClip, clipsOnTrack } from '../../src/core/project';
import {
  clearRange,
  closeGapAt,
  deleteClips,
  makeRoomFor,
  moveClips,
  normalize,
  setSpeed,
  splitClip,
  trimEnd,
  trimStart,
  splitAt,
  detachAudio,
  duplicateClips,
  frameCues,
} from '../../src/core/ops';
import { evaluateFrame } from '../../src/core/evaluate';
import { upsertKeyframe, evalProp } from '../../src/core/keyframes';
import type { Asset, Project, VideoClip } from '../../src/core/types';

function asset(id: string, duration = 10, withAudio = true): Asset {
  return {
    id,
    kind: 'video',
    name: id + '.mp4',
    mimeType: 'video/mp4',
    size: 1,
    lastModified: 0,
    duration,
    status: 'ready',
    stored: true,
    createdAt: 0,
    video: { width: 1920, height: 1080, rotation: 0, fps: 30, codec: 'avc', hasAlpha: false },
    audio: withAudio ? { sampleRate: 48000, channels: 2, codec: 'aac', conformed: true } : undefined,
  };
}

function setup(): { p: Project; v1: string; a1: string } {
  const p = createProject('t');
  p.assets.A = asset('A');
  const v1 = p.tracks.find((t) => t.kind === 'video' && t.name === 'Video 1')!.id;
  const a1 = p.tracks.find((t) => t.kind === 'audio')!.id;
  return { p, v1, a1 };
}

function addVideo(p: Project, trackId: string, start: number, duration: number, sourceIn = 0): VideoClip {
  const c = createVideoClip(p.assets.A, { trackId, start, duration });
  c.sourceIn = sourceIn;
  p.clips[c.id] = c;
  return c;
}

describe('split', () => {
  it('splits a clip into two contiguous pieces with correct source offsets', () => {
    const { p, v1 } = setup();
    const c = addVideo(p, v1, 1, 6, 2);
    const next = produce(p, (d) => {
      const rid = splitClip(d, c.id, 3);
      expect(rid).toBeTruthy();
    });
    const pieces = clipsOnTrack(next, v1);
    expect(pieces).toHaveLength(2);
    const [l, r] = pieces as VideoClip[];
    expect(l.start).toBeCloseTo(1);
    expect(l.duration).toBeCloseTo(2);
    expect(r.start).toBeCloseTo(3);
    expect(r.duration).toBeCloseTo(4);
    expect(l.sourceIn).toBeCloseTo(2);
    expect(r.sourceIn).toBeCloseTo(4);
  });

  it('respects speed when computing the right piece source time', () => {
    const { p, v1 } = setup();
    const c = addVideo(p, v1, 0, 4, 0);
    c.speed = 2;
    const next = produce(p, (d) => void splitClip(d, c.id, 1));
    const r = clipsOnTrack(next, v1)[1] as VideoClip;
    expect(r.sourceIn).toBeCloseTo(2);
  });

  it('refuses to split at the edges', () => {
    const { p, v1 } = setup();
    const c = addVideo(p, v1, 0, 4);
    produce(p, (d) => {
      expect(splitClip(d, c.id, 0)).toBeNull();
      expect(splitClip(d, c.id, 4)).toBeNull();
    });
  });

  it('keeps keyframed values continuous across the split', () => {
    const { p, v1 } = setup();
    const c = addVideo(p, v1, 0, 4);
    upsertKeyframe(c, 'transform.opacity', 0, 0);
    upsertKeyframe(c, 'transform.opacity', 4, 1);
    const before = evalProp(c, 'transform.opacity', 3);
    const next = produce(p, (d) => void splitClip(d, c.id, 2));
    const r = clipsOnTrack(next, v1)[1];
    expect(evalProp(r, 'transform.opacity', 1)).toBeCloseTo(before);
  });

  it('splitAt splits every clip under the playhead', () => {
    const { p, v1 } = setup();
    addVideo(p, v1, 0, 5);
    const t2 = p.tracks[0].id;
    const tc = createTextClip({ trackId: t2, start: 1, duration: 3 });
    p.clips[tc.id] = tc;
    const next = produce(p, (d) => void splitAt(d, 2));
    expect(Object.keys(next.clips)).toHaveLength(4);
  });
});

describe('trim', () => {
  it('cannot extend a video clip past its media', () => {
    const { p, v1 } = setup();
    const c = addVideo(p, v1, 0, 5, 3);
    const next = produce(p, (d) => trimEnd(d, c.id, 20));
    expect(next.clips[c.id].duration).toBeCloseTo(7); // 10s media - 3s in
  });

  it('cannot extend the head before source start', () => {
    const { p, v1 } = setup();
    const c = addVideo(p, v1, 5, 2, 1);
    const next = produce(p, (d) => trimStart(d, c.id, 0));
    const r = next.clips[c.id] as VideoClip;
    expect(r.start).toBeCloseTo(4);
    expect(r.sourceIn).toBeCloseTo(0);
    expect(r.duration).toBeCloseTo(3);
  });

  it('allows images to be extended freely', () => {
    const { p, v1 } = setup();
    p.assets.I = { ...asset('I'), kind: 'image', duration: 0, video: undefined, audio: undefined, image: { width: 10, height: 10 } };
    const c = createImageClip(p.assets.I, { trackId: v1, start: 0, duration: 5 });
    p.clips[c.id] = c;
    const next = produce(p, (d) => trimEnd(d, c.id, 60));
    expect(next.clips[c.id].duration).toBeCloseTo(60);
  });

  it('quantizes to the frame grid', () => {
    const { p, v1 } = setup();
    const c = addVideo(p, v1, 0, 5);
    const next = produce(p, (d) => trimEnd(d, c.id, 2.0123));
    expect(next.clips[c.id].duration * 30).toBeCloseTo(Math.round(2.0123 * 30));
  });
});

describe('overwrite placement', () => {
  it('splits a clip that fully covers the inserted range', () => {
    const { p, v1 } = setup();
    addVideo(p, v1, 0, 10);
    const next = produce(p, (d) => clearRange(d, v1, 2, 4));
    const clips = clipsOnTrack(next, v1) as VideoClip[];
    expect(clips).toHaveLength(2);
    expect(clips[0].duration).toBeCloseTo(2);
    expect(clips[1].start).toBeCloseTo(4);
    expect(clips[1].sourceIn).toBeCloseTo(4);
  });

  it('moving a clip onto another trims the one underneath', () => {
    const { p, v1 } = setup();
    const a = addVideo(p, v1, 0, 4);
    const b = addVideo(p, v1, 6, 4);
    const next = produce(p, (d) => moveClips(d, { clipIds: [b.id], dt: -3, trackDelta: 0, mode: 'overwrite' }));
    expect(next.clips[a.id].duration).toBeCloseTo(3);
    expect(next.clips[b.id].start).toBeCloseTo(3);
  });

  it('insert mode pushes later clips right', () => {
    const { p, v1 } = setup();
    const a = addVideo(p, v1, 0, 4);
    const b = addVideo(p, v1, 4, 4);
    const c = addVideo(p, v1, 20, 2);
    const next = produce(p, (d) => {
      d.clips[c.id].start = 4;
      makeRoomFor(d, [c.id], 'insert');
    });
    expect(next.clips[a.id].start).toBeCloseTo(0);
    expect(next.clips[c.id].start).toBeCloseTo(4);
    expect(next.clips[b.id].start).toBeCloseTo(6);
  });

  it('never moves clips before zero', () => {
    const { p, v1 } = setup();
    const a = addVideo(p, v1, 1, 2);
    const next = produce(p, (d) => moveClips(d, { clipIds: [a.id], dt: -5, trackDelta: 0, mode: 'overwrite' }));
    expect(next.clips[a.id].start).toBe(0);
  });
});

describe('delete & gaps', () => {
  it('ripple delete closes the gap', () => {
    const { p, v1 } = setup();
    const a = addVideo(p, v1, 0, 2);
    const b = addVideo(p, v1, 2, 3);
    const c = addVideo(p, v1, 5, 1);
    const next = produce(p, (d) => deleteClips(d, [b.id], true));
    expect(next.clips[a.id].start).toBe(0);
    expect(next.clips[c.id].start).toBeCloseTo(2);
  });

  it('closes a gap at a time', () => {
    const { p, v1 } = setup();
    addVideo(p, v1, 0, 2);
    const b = addVideo(p, v1, 5, 1);
    const next = produce(p, (d) => void closeGapAt(d, v1, 3));
    expect(next.clips[b.id].start).toBeCloseTo(2);
  });
});

describe('speed', () => {
  it('halving speed doubles duration and pushes the next clip', () => {
    const { p, v1 } = setup();
    const a = addVideo(p, v1, 0, 2);
    const b = addVideo(p, v1, 2, 2);
    const next = produce(p, (d) => setSpeed(d, a.id, 0.5));
    expect(next.clips[a.id].duration).toBeCloseTo(4);
    expect(next.clips[b.id].start).toBeCloseTo(4);
  });

  it('cannot exceed available media when slowing down', () => {
    const { p, v1 } = setup();
    const a = addVideo(p, v1, 0, 8, 0);
    const next = produce(p, (d) => setSpeed(d, a.id, 0.5));
    expect(next.clips[a.id].duration).toBeCloseTo(16);
  });
});

describe('transitions', () => {
  it('are dropped when the clips no longer touch', () => {
    const { p, v1 } = setup();
    const a = addVideo(p, v1, 0, 2);
    const b = addVideo(p, v1, 2, 2);
    a.transitionOut = { type: 'crossfade', duration: 1 };
    const kept = produce(p, (d) => normalize(d));
    expect((kept.clips[a.id] as VideoClip).transitionOut).toBeTruthy();
    const next = produce(p, (d) => {
      d.clips[b.id].start = 3;
      normalize(d);
    });
    expect((next.clips[a.id] as VideoClip).transitionOut).toBeUndefined();
  });

  it('render both clips during the transition window', () => {
    const { p, v1 } = setup();
    const a = addVideo(p, v1, 0, 2);
    addVideo(p, v1, 2, 2);
    a.transitionOut = { type: 'crossfade', duration: 1 };
    const mid = evaluateFrame(p, 2.0);
    expect(mid.layers).toHaveLength(1);
    expect(mid.layers[0].type).toBe('transition');
    if (mid.layers[0].type === 'transition') expect(mid.layers[0].progress).toBeCloseTo(0.5);
    const before = evaluateFrame(p, 1.4);
    expect(before.layers[0].type).toBe('clip');
  });
});

describe('detach audio', () => {
  it('creates an audio clip with matching timing and mutes the video', () => {
    const { p, v1, a1 } = setup();
    const v = addVideo(p, v1, 1, 3, 2);
    let id: string | null = null;
    const next = produce(p, (d) => {
      id = detachAudio(d, v.id);
    });
    const a = next.clips[id!];
    expect(a.type).toBe('audio');
    expect(a.trackId).toBe(a1);
    expect(a.start).toBeCloseTo(1);
    expect((a as VideoClip).sourceIn).toBeCloseTo(2);
    expect((next.clips[v.id] as VideoClip).muted).toBe(true);
  });
});

describe('evaluate', () => {
  it('stacks tracks bottom-to-top and maps source time', () => {
    const { p, v1 } = setup();
    const v = addVideo(p, v1, 1, 4, 3);
    const top = p.tracks[0].id;
    const t = createTextClip({ trackId: top, start: 0, duration: 10 });
    p.clips[t.id] = t;
    const f = evaluateFrame(p, 2);
    expect(f.layers.map((l) => (l.type === 'clip' ? l.clipId : ''))).toEqual([v.id, t.id]);
    const l0 = f.layers[0];
    if (l0.type === 'clip' && l0.source.kind === 'video') expect(l0.source.time).toBeCloseTo(4);
  });

  it('skips hidden tracks', () => {
    const { p, v1 } = setup();
    addVideo(p, v1, 0, 4);
    p.tracks.find((t) => t.id === v1)!.hidden = true;
    expect(evaluateFrame(p, 1).layers).toHaveLength(0);
  });

  it('applies fade-in animation to opacity', () => {
    const { p, v1 } = setup();
    const v = addVideo(p, v1, 0, 4);
    v.animIn = { preset: 'fade', duration: 1 };
    const f0 = evaluateFrame(p, 0);
    const f1 = evaluateFrame(p, 1.5);
    expect(f0.layers[0].type === 'clip' && f0.layers[0].opacity).toBeCloseTo(0);
    expect(f1.layers[0].type === 'clip' && f1.layers[0].opacity).toBeCloseTo(1);
  });
});

describe('duplicate and detach', () => {
  it('duplicate pushes the following clips later instead of covering them', () => {
    const { p, v1 } = setup();
    const a = addVideo(p, v1, 0, 2);
    addVideo(p, v1, 2, 2, 5);
    const next = produce(p, (d) => {
      duplicateClips(d, [a.id]);
    });
    const onTrack = clipsOnTrack(next, v1).map((c) => [c.start, c.duration, (c as VideoClip).sourceIn]);
    expect(onTrack).toEqual([
      [0, 2, 0],
      [2, 2, 0],
      [4, 2, 5], // b intact, just later
    ]);
  });

  it('detaching audio twice does not duplicate the soundtrack', () => {
    const { p, v1 } = setup();
    const v = addVideo(p, v1, 0, 3);
    const next = produce(p, (d) => {
      expect(detachAudio(d, v.id)).not.toBeNull();
      expect(detachAudio(d, v.id)).toBeNull();
    });
    expect(Object.values(next.clips).filter((c) => c.type === 'audio')).toHaveLength(1);
  });
});

describe('captions', () => {
  it('splitting a caption divides its text instead of copying it', () => {
    const p = createProject('t');
    const tr = p.tracks.find((t) => t.kind === 'video')!.id;
    const c = createCaptionClip({ trackId: tr, start: 0, duration: 4 }, 'one two three four');
    p.clips[c.id] = c;
    const next = produce(p, (d) => void splitClip(d, c.id, 2));
    expect(Object.values(next.clips).map((x) => (x as { text: string }).text).sort()).toEqual(['one two', 'three four']);
  });

  it('with word timing, each half keeps the words spoken in it', () => {
    const p = createProject('t');
    const tr = p.tracks.find((t) => t.kind === 'video')!.id;
    const c = createCaptionClip({ trackId: tr, start: 0, duration: 4 }, 'a b c');
    c.words = [
      { text: 'a', start: 0, end: 1 },
      { text: 'b', start: 1.2, end: 1.8 },
      { text: 'c', start: 3, end: 3.5 },
    ];
    p.clips[c.id] = c;
    const next = produce(p, (d) => void splitClip(d, c.id, 2));
    const parts = Object.values(next.clips).sort((a, b) => a.start - b.start) as { text: string; words: { start: number }[] }[];
    expect(parts.map((x) => x.text)).toEqual(['a b', 'c']);
    expect(parts[1].words[0].start).toBeCloseTo(1, 6);
  });

  it('frame-aligned cues never overlap their neighbours', () => {
    const p = createProject('t'); // 30 fps
    const cues = [
      { start: 0.01, end: 1.016 },
      { start: 1.01, end: 2.5 },
      { start: 2.49, end: 2.6 },
    ];
    const out = frameCues(p, cues);
    for (let i = 1; i < out.length; i++) expect(out[i].qStart).toBeGreaterThanOrEqual(out[i - 1].qEnd - 1e-9);
  });
});

import { removeTimeRanges } from '../../src/core/ops';

describe('removing time across tracks', () => {
  it('cuts every given track the same way, splitting clips that span a cut', () => {
    const { p, v1, a1 } = setup();
    addVideo(p, v1, 0, 10);
    const cap = p.tracks.find((t) => t.kind === 'video' && t.id !== v1)!.id;
    const t1 = createTextClip({ trackId: cap, start: 4, duration: 2 }, 'during');
    const t2 = createTextClip({ trackId: cap, start: 8, duration: 1 }, 'after');
    p.clips[t1.id] = t1;
    p.clips[t2.id] = t2;
    p.markers.push({ id: 'm', t: 9, label: 'm', color: '#fff' });
    const next = produce(p, (d) => removeTimeRanges(d, [{ start: 2, end: 3 }, { start: 5, end: 5.5 }], [v1, cap, a1]));
    const vids = clipsOnTrack(next, v1).map((c) => [c.start, c.duration]);
    expect(vids.reduce((n, [, dur]) => n + dur, 0)).toBeCloseTo(8.5, 6);
    const texts = clipsOnTrack(next, cap).map((c) => [+c.start.toFixed(3), +c.duration.toFixed(3)]);
    // "during" (4–6) loses 0.5 s in the middle and moves 1 s earlier; "after" moves 1.5 s earlier.
    expect(texts).toEqual([
      [3, 1],
      [4, 0.5],
      [6.5, 1],
    ]);
    expect(next.markers[0].t).toBeCloseTo(7.5, 6);
  });
});

import { audibleSegments } from '../../src/core/audio';
import { createAudioClip } from '../../src/core/project';

describe('solo', () => {
  it('when a track is soloed, only soloed tracks are heard', () => {
    const { p, v1, a1 } = setup();
    addVideo(p, v1, 0, 5);
    const music = createAudioClip(p.assets.A, { trackId: a1, start: 0, duration: 5 });
    p.clips[music.id] = music;
    expect(audibleSegments(p, 0, 5)).toHaveLength(2);
    p.tracks.find((t) => t.id === a1)!.solo = true;
    expect(audibleSegments(p, 0, 5).map((s) => s.clip.id)).toEqual([music.id]);
  });
});
