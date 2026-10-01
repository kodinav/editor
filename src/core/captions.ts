/**
 * Subtitle parsing and serialization (SRT and WebVTT). Parsing is tolerant of
 * real-world files: BOMs, CRLF line endings, missing indices, comma or dot
 * millisecond separators, inline tags, and VTT cue settings.
 */

export interface Cue {
  start: number;
  end: number;
  text: string;
}

const TIME_RE = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/;

function parseStamp(s: string): number | null {
  const m = TIME_RE.exec(s.trim());
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return h * 3600 + min * 60 + sec + ms / 1000;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

export function parseSubtitles(input: string): Cue[] {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n{2,}/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.length > 0);
    const arrowIdx = lines.findIndex((l) => l.includes('-->'));
    if (arrowIdx < 0) continue;
    const [a, b] = lines[arrowIdx].split('-->');
    const start = parseStamp(a);
    const end = parseStamp(b ?? '');
    if (start == null || end == null || end <= start) continue;
    const body = stripTags(lines.slice(arrowIdx + 1).join('\n')).trim();
    if (!body) continue;
    cues.push({ start, end, text: body });
  }
  cues.sort((x, y) => x.start - y.start);
  return cues;
}

function fmt(t: number, sep: ',' | '.'): string {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`;
}

export function toSRT(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${fmt(c.start, ',')} --> ${fmt(c.end, ',')}\n${c.text}\n`).join('\n');
}

export function toVTT(cues: Cue[]): string {
  return 'WEBVTT\n\n' + cues.map((c) => `${fmt(c.start, '.')} --> ${fmt(c.end, '.')}\n${c.text}\n`).join('\n');
}

/**
 * Split long text into caption-sized chunks with proportional timing. Used
 * when a user pastes a transcript without timings.
 */
export function chunkTranscript(text: string, start: number, wordsPerSecond = 2.6, maxWords = 8): Cue[] {
  const words = text.split(/\s+/).filter(Boolean);
  const cues: Cue[] = [];
  let t = start;
  for (let i = 0; i < words.length; i += maxWords) {
    const chunk = words.slice(i, i + maxWords);
    const dur = Math.max(1, chunk.length / wordsPerSecond);
    cues.push({ start: t, end: t + dur, text: chunk.join(' ') });
    t += dur;
  }
  return cues;
}
