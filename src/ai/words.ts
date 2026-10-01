/**
 * Turning word-level transcripts into readable captions. Pure functions, so
 * they are unit-tested independently of the speech model.
 */

export interface Word {
  text: string;
  start: number;
  end: number;
}

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
  /** Word timings relative to `start`. */
  words: Word[];
}

export interface GroupOptions {
  maxChars: number;
  maxDuration: number;
  /** A silence longer than this always starts a new caption. */
  maxGap: number;
  /** Keep captions on screen at least this long when possible. */
  minDuration: number;
}

export const DEFAULT_GROUPING: GroupOptions = { maxChars: 42, maxDuration: 3.5, maxGap: 0.6, minDuration: 0.8 };

/** Whisper emits filler like "[Music]" or "(applause)" for non-speech. */
export function isNonSpeech(text: string): boolean {
  const t = text.trim();
  return /^[[(].*[\])]$/.test(t) || t === '' || /^[♪♫\s]+$/.test(t);
}

export function groupWords(words: Word[], opts: GroupOptions = DEFAULT_GROUPING): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let cur: Word[] = [];
  const textOf = (ws: Word[]) => ws.map((w) => w.text.trim()).join(' ').replace(/\s+([,.!?;:])/g, '$1');
  const flush = () => {
    if (!cur.length) return;
    cues.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: textOf(cur), words: cur });
    cur = [];
  };
  for (const w of words) {
    if (isNonSpeech(w.text)) continue;
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const tooLong = textOf([...cur, w]).length > opts.maxChars;
      const tooSlow = w.end - cur[0].start > opts.maxDuration;
      const gap = w.start - prev.end > opts.maxGap;
      const sentenceEnd = /[.!?…]["”']?$/.test(prev.text.trim()) && cur.length >= 2;
      if (tooLong || tooSlow || gap || sentenceEnd) flush();
    }
    cur.push({ text: w.text, start: w.start, end: Math.max(w.end, w.start + 0.05) });
  }
  flush();
  // Extend short captions into the following gap so they're readable.
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : Infinity;
    const want = Math.max(c.end, c.start + opts.minDuration, c.end + 0.25);
    c.end = Math.min(want, nextStart);
    c.words = c.words.map((w) => ({ text: w.text.trim(), start: w.start - c.start, end: w.end - c.start }));
  }
  return cues.filter((c) => c.end - c.start > 0.05 && c.text.trim());
}

/**
 * Pick window boundaries for long audio: aim for `target` seconds and cut at
 * the quietest point within the last `search` seconds, so words aren't split.
 */
export function chooseWindows(rms: Float32Array, win: number, total: number, target = 28, search = 6): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  while (start < total - 0.05) {
    let end = Math.min(total, start + target);
    if (end < total) {
      const a = Math.max(start + target - search, start + 1);
      let best = end;
      let bestV = Infinity;
      for (let t = a; t <= end; t += win) {
        const v = rms[Math.min(rms.length - 1, Math.floor(t / win))];
        if (v < bestV) {
          bestV = v;
          best = t;
        }
      }
      end = best;
    }
    out.push([start, end]);
    start = end;
  }
  return out;
}
