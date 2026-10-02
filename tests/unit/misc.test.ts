import { describe, expect, it } from 'vitest';
import { parseSubtitles, toSRT, toVTT } from '../../src/core/captions';
import { sampleKeyframes } from '../../src/core/keyframes';
import { formatTimecode, parseTime, snapToFrame } from '../../src/core/time';
import { parseProject, ProjectValidationError } from '../../src/core/schema';
import { createProject } from '../../src/core/project';
import { fittedSize, layerGeometry, hitTest } from '../../src/core/geometry';
import type { Keyframe } from '../../src/core/types';

describe('captions', () => {
  it('parses SRT with CRLF, BOM and tags', () => {
    const srt = '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i> world\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nSecond\r\nline\r\n';
    const cues = parseSubtitles(srt);
    expect(cues).toEqual([
      { start: 1, end: 2.5, text: 'Hello world' },
      { start: 3, end: 4, text: 'Second\nline' },
    ]);
  });

  it('parses WebVTT with settings and short timestamps', () => {
    const vtt = 'WEBVTT\n\nintro\n00:01.000 --> 00:02.000 align:start\nHi\n\n00:00:05.250 --> 00:00:06.000\nThere';
    const cues = parseSubtitles(vtt);
    expect(cues.map((c) => c.start)).toEqual([1, 5.25]);
  });

  it('round-trips through SRT and VTT', () => {
    const cues = [{ start: 0.5, end: 1.75, text: 'A' }, { start: 3661.001, end: 3662, text: 'B' }];
    expect(parseSubtitles(toSRT(cues))).toEqual(cues);
    expect(parseSubtitles(toVTT(cues))).toEqual(cues);
  });

  it('ignores malformed cues', () => {
    expect(parseSubtitles('garbage\n\n00:00:02,000 --> 00:00:01,000\nbackwards')).toEqual([]);
  });
});

describe('keyframes', () => {
  const kfs: Keyframe[] = [
    { id: 'a', t: 0, v: 0, ease: 'linear' },
    { id: 'b', t: 2, v: 10, ease: 'hold' },
    { id: 'c', t: 4, v: 20, ease: 'linear' },
  ];
  it('interpolates and holds', () => {
    expect(sampleKeyframes(kfs, -1)).toBe(0);
    expect(sampleKeyframes(kfs, 1)).toBeCloseTo(5);
    expect(sampleKeyframes(kfs, 3)).toBe(10);
    expect(sampleKeyframes(kfs, 5)).toBe(20);
  });
});

describe('time', () => {
  it('formats and parses timecode', () => {
    expect(formatTimecode(3661.5, 30)).toBe('01:01:01:15');
    expect(parseTime('01:01:01:15', 30)).toBeCloseTo(3661.5);
    expect(parseTime('1:30', 30)).toBe(90);
    expect(parseTime('12.5', 30)).toBe(12.5);
    expect(parseTime('abc', 30)).toBeNull();
  });
  it('snaps to frames', () => {
    expect(snapToFrame(1.01, 30) * 30).toBeCloseTo(30);
  });
});

describe('schema', () => {
  it('accepts a fresh project and fills defaults', () => {
    const p = createProject('x');
    const json = JSON.parse(JSON.stringify(p));
    delete json.markers;
    const parsed = parseProject(json);
    expect(parsed.markers).toEqual([]);
    expect(parsed.tracks.length).toBe(3);
  });
  it('rejects garbage', () => {
    expect(() => parseProject({ id: 1 })).toThrow(ProjectValidationError);
    expect(() => parseProject({ ...createProject('x'), settings: { width: -5 } })).toThrow(ProjectValidationError);
  });
});

describe('geometry', () => {
  it('fits sources', () => {
    expect(fittedSize('contain', { w: 1080, h: 1920 }, { w: 1920, h: 1080 })).toEqual({ w: 607.5, h: 1080 });
    expect(fittedSize('cover', { w: 1080, h: 1920 }, { w: 1920, h: 1080 }).w).toBeCloseTo(1920);
  });
  it('hit-tests rotated layers', () => {
    const g = layerGeometry({ x: 0, y: 0, scale: 0.5, rotation: 45, crop: { left: 0, right: 0, top: 0, bottom: 0 }, fit: 'contain' }, { w: 100, h: 100 }, { w: 1000, h: 1000 });
    expect(hitTest(g, { x: 500, y: 500 })).toBe(true);
    // Corner of the unrotated square lies outside the rotated one.
    expect(hitTest(g, { x: 500 + 240, y: 500 + 240 })).toBe(false);
  });
});

import { silentRegions } from '../../src/core/silence';
describe('silence detection', () => {
  it('pads interior gaps but removes edge silence entirely', () => {
    // 20 ms windows: 1 s sound, 1 s silence, 1 s sound, 1 s silence (trailing)
    const w = 0.02;
    const rms = new Float32Array(200);
    for (let i = 0; i < 200; i++) rms[i] = (i < 50 || (i >= 100 && i < 150)) ? 0.3 : 0.0001;
    const r = silentRegions(rms, 0, w, { thresholdDb: -40, minSilence: 0.6, padding: 0.15 });
    expect(r).toHaveLength(2);
    expect(r[0].start).toBeCloseTo(1.15);
    expect(r[0].end).toBeCloseTo(1.85);
    expect(r[1].start).toBeCloseTo(3.15);
    expect(r[1].end).toBeCloseTo(4.0);
  });
  it('ignores short pauses', () => {
    const rms = new Float32Array(100).fill(0.3);
    for (let i = 40; i < 50; i++) rms[i] = 0; // 0.2 s
    expect(silentRegions(rms, 0, 0.02, { thresholdDb: -40, minSilence: 0.6, padding: 0.1 })).toHaveLength(0);
  });
});

import { chooseWindows, groupWords, isNonSpeech } from '../../src/ai/words';
describe('caption grouping', () => {
  const w = (text: string, start: number, end: number) => ({ text, start, end });
  it('breaks on sentence ends, long pauses and length', () => {
    const words = [
      w(' Hello', 0, 0.4), w(' there.', 0.45, 0.9), w(' This', 1.0, 1.2), w(' is', 1.25, 1.4), w(' a', 1.45, 1.5),
      w(' test', 1.55, 1.9), w(' after', 3.0, 3.3), w(' a', 3.35, 3.4), w(' pause', 3.45, 3.9),
    ];
    const cues = groupWords(words);
    expect(cues.map((c) => c.text)).toEqual(['Hello there.', 'This is a test', 'after a pause']);
    expect(cues[0].words[0]).toEqual({ text: 'Hello', start: 0, end: 0.4 });
    // Words are relative to their caption's start.
    expect(cues[2].words[0].start).toBeCloseTo(0);
    // Captions never overlap.
    for (let i = 1; i < cues.length; i++) expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].end - 1e-9);
  });
  it('drops non-speech annotations', () => {
    expect(isNonSpeech(' [Music]')).toBe(true);
    expect(isNonSpeech('(applause)')).toBe(true);
    expect(isNonSpeech(' Hi')).toBe(false);
    expect(groupWords([w(' [Music]', 0, 1)])).toEqual([]);
  });
  it('splits long audio at the quietest point near each window end', () => {
    const win = 0.02;
    const total = 70;
    const rms = new Float32Array(Math.ceil(total / win)).fill(0.2);
    rms[Math.round(25 / win)] = 0.0001; // a pause at 25 s
    rms[Math.round(52 / win)] = 0.0001; // a pause at 52 s
    const wins = chooseWindows(rms, win, total, 28, 6);
    expect(wins[0][1]).toBeCloseTo(25, 1);
    expect(wins[1][1]).toBeCloseTo(52, 1);
    expect(wins[wins.length - 1][1]).toBe(70);
    for (const [a, b] of wins) expect(b - a).toBeLessThanOrEqual(28.0001);
  });
});

import { duckKeyframes, mergeActivity } from '../../src/core/ducking';
import { sampleKeyframes as sk } from '../../src/core/keyframes';
describe('ducking', () => {
  let n = 0;
  const id = () => `k${n++}`;
  it('merges nearby speech and drops blips', () => {
    expect(mergeActivity([{ start: 1, end: 2 }, { start: 2.3, end: 3 }, { start: 5, end: 5.1 }], 0.5, 0.2)).toEqual([{ start: 1, end: 3 }]);
  });
  it('dips during speech and recovers after', () => {
    const k = duckKeyframes([{ start: 2, end: 4 }], 10, 1, { amountDb: -20, attack: 0.25, release: 0.5 }, id);
    expect(sk(k, 0.5)).toBeCloseTo(1);
    expect(sk(k, 3)).toBeCloseTo(0.1); // -20 dB
    expect(sk(k, 6)).toBeCloseTo(1);
    // Ramps start before speech and end after it.
    expect(sk(k, 1.9)).toBeLessThan(1);
    expect(sk(k, 4.3)).toBeLessThan(1);
    expect(sk(k, 4.3)).toBeGreaterThan(0.1);
  });
  it('handles speech at the clip edges', () => {
    const k = duckKeyframes([{ start: 0, end: 1 }, { start: 9.5, end: 10 }], 10, 0.8, { amountDb: -6, attack: 0.25, release: 0.5 }, id);
    expect(sk(k, 0)).toBeCloseTo(0.8 * Math.pow(10, -6 / 20));
    expect(sk(k, 10)).toBeCloseTo(0.8 * Math.pow(10, -6 / 20));
    expect(sk(k, 5)).toBeCloseTo(0.8);
  });
});


describe('timecode', () => {
  it('typing back a displayed timecode lands on the same frame at any frame rate', () => {
    for (const fps of [23.976, 24, 25, 29.97, 30, 59.94, 60]) {
      for (const t of [0, 1.234, 59.9, 61.5, 600.01, 3599.5]) {
        const shown = formatTimecode(t, fps);
        expect(parseTime(shown, fps), `${fps} fps, ${shown}`).toBeCloseTo(snapToFrame(t, fps), 9);
      }
    }
  });
});

describe('caption grouping by script', () => {
  it('joins words without spaces for languages written without them', () => {
    const words = [
      { text: '你好', start: 0, end: 0.4 },
      { text: '世界', start: 0.4, end: 0.8 },
    ];
    expect(groupWords(words, { maxChars: 20, maxDuration: 3, maxGap: 0.6, minDuration: 0.5, noSpaces: true })[0].text).toBe('你好世界');
    expect(groupWords(words, { maxChars: 20, maxDuration: 3, maxGap: 0.6, minDuration: 0.5 })[0].text).toBe('你好 世界');
  });
});
