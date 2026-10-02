import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Page } from '@playwright/test';
import ffmpegPath from 'ffmpeg-static';

export const fixture = (name: string) => path.resolve('tests/fixtures', name);
const FF = ffmpegPath as unknown as string;

export interface ProbeInfo {
  duration: number;
  video?: { codec: string; width: number; height: number; fps: number };
  audio?: { codec: string; sampleRate: number; channels: string };
}

/** Parse `ffmpeg -i` output (ffprobe isn't available for this platform in npm). */
export function probe(file: string): ProbeInfo {
  const out = String(spawnSync(FF, ['-hide_banner', '-i', file]).stderr);
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(out);
  const info: ProbeInfo = { duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0 };
  const v = /Video: (\w+).*?, (\d+)x(\d+)[ ,].*?([\d.]+) fps/.exec(out);
  if (v) info.video = { codec: v[1], width: +v[2], height: +v[3], fps: +v[4] };
  const a = /Audio: (\w+).*?, (\d+) Hz, (\w+)/.exec(out);
  if (a) info.audio = { codec: a[1], sampleRate: +a[2], channels: a[3] };
  return info;
}

/** Decode the whole file; throws if ffmpeg reports any error. */
export function decodesCleanly(file: string): boolean {
  const r = execFileSync(FF, ['-hide_banner', '-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: 'pipe' });
  return r.length === 0;
}

/** Average RGB of a region of the frame at time t (region in fractions of the frame). */
export function regionColor(file: string, t: number, rx = 0.1, ry = 0.1, rw = 0.05, rh = 0.05): [number, number, number] {
  const info = probe(file);
  const W = info.video!.width;
  const H = info.video!.height;
  const crop = `crop=${Math.max(2, Math.round(W * rw))}:${Math.max(2, Math.round(H * rh))}:${Math.round(W * rx)}:${Math.round(H * ry)},scale=1:1:flags=area`;
  const buf = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', crop, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: 'pipe' });
  return [buf[0], buf[1], buf[2]];
}

/** Mean volume (dB) of a time range. */
export function meanVolume(file: string, start: number, dur: number): number {
  const out = String(spawnSync(FF, ['-hide_banner', '-ss', String(start), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-f', 'null', '-']).stderr);
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(out);
  return m ? (m[1] === '-inf' ? -Infinity : parseFloat(m[1])) : NaN;
}

/** Dominant frequency estimate via zero crossings of the decoded mono signal. */
export function dominantFrequency(file: string, start: number, dur: number): number {
  const buf = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(dur), '-i', file, '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  const n = buf.length / 2;
  let crossings = 0;
  let prev = buf.readInt16LE(0);
  for (let i = 1; i < n; i++) {
    const v = buf.readInt16LE(i * 2);
    if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) crossings++;
    prev = v;
  }
  return crossings / 2 / (n / 48000);
}

export async function openEditor(page: Page) {
  await page.goto('/?debug');
  await page.waitForFunction(() => !!(window as unknown as { __cutline?: unknown }).__cutline);
}

export async function importFiles(page: Page, names: string[]) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: /^Import/ }).first().click()]);
  await chooser.setFiles(names.map(fixture));
}

export async function waitForMediaReady(page: Page) {
  await page.waitForFunction(
    () => {
      const s = (window as any).__cutline.editor.getState();
      return Object.values(s.project.assets).every((a: any) => a.status !== 'processing' && (a.status === 'error' || !a.audio || a.audio.conformed));
    },
    null,
    { timeout: 60_000 },
  );
}

export async function state(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).__cutline.editor.getState();
    return {
      settings: s.project.settings,
      assets: Object.values(s.project.assets) as any[],
      clips: (Object.values(s.project.clips) as any[]).sort((a, b) => a.start - b.start || a.trackId.localeCompare(b.trackId)),
      tracks: s.project.tracks as any[],
      inPoint: s.project.inPoint as number | null,
      outPoint: s.project.outPoint as number | null,
      past: s.past.length,
      selection: s.selection as string[],
      toasts: s.toasts as any[],
    };
  });
}

export async function seek(page: Page, t: number) {
  await page.evaluate((x) => (window as any).__cutline.player.seek(x), t);
}

/** Run an export through the dialog and return the saved file path. */
export async function exportVia(page: Page, outPath: string, setup?: () => Promise<void>) {
  // A previous export leaves its "complete" dialog open; dismiss it like a user would.
  const done = page.getByRole('dialog').getByRole('button', { name: 'Done', exact: true });
  if (await done.isVisible()) await done.click();
  await page.keyboard.press('ControlOrMeta+e');
  await page.getByRole('dialog').waitFor();
  if (setup) await setup();
  const dl = page.waitForEvent('download', { timeout: 170_000 });
  await page.getByRole('button', { name: /^Export (video|audio)/ }).click();
  // Fail fast with the app's own message instead of waiting for a download that never comes.
  const failed = page
    .getByText('The export didn’t finish.')
    .waitFor({ timeout: 170_000 })
    .then(async () => {
      throw new Error(`Export failed: ${await page.locator('.callout.err').innerText()}`);
    });
  const d = await Promise.race([dl, failed]);
  failed.catch(() => {});
  await d.saveAs(outPath);
  return outPath;
}

/** Count pixels in a frame region (fractions) that satisfy a predicate. */
export function countPixels(file: string, t: number, rx: number, ry: number, rw: number, rh: number, pred: (r: number, g: number, b: number) => boolean): number {
  const info = probe(file);
  const W = info.video!.width;
  const H = info.video!.height;
  const cw = Math.max(2, Math.round(W * rw));
  const ch = Math.max(2, Math.round(H * rh));
  const crop = `crop=${cw}:${ch}:${Math.round(W * rx)}:${Math.round(H * ry)}`;
  const buf = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', crop, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
  let n = 0;
  for (let i = 0; i + 2 < buf.length; i += 3) if (pred(buf[i], buf[i + 1], buf[i + 2])) n++;
  return n;
}

/** Times (s) of frames whose average luma exceeds `thr` (e.g. flash frames). */
export function brightFrames(file: string, thr = 100): number[] {
  const out = String(spawnSync(FF, ['-hide_banner', '-i', file, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-']).stderr);
  const times: number[] = [];
  let pts = 0;
  for (const line of out.split('\n')) {
    const p = /pts_time:([\d.]+)/.exec(line);
    if (p) pts = parseFloat(p[1]);
    const y = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (y && parseFloat(y[1]) > thr) times.push(pts);
  }
  return times;
}

/**
 * Onset times (s) where the mono signal rises above `thr` after at least `gap` s of quiet.
 * Samples are laid out back to back from the first frame's presentation time (edit list,
 * codec delay), the way players feed audio to the output device.
 */
export function audioOnsets(file: string, thr = 0.2, gap = 0.5): number[] {
  const info = String(spawnSync(FF, ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'ashowinfo', '-frames:a', '1', '-f', 'null', '-']).stderr);
  const first = /pts_time:(-?[\d.]+)/.exec(info);
  const t0 = first ? parseFloat(first[1]) : 0;
  const buf = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], { stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 });
  const onsets: number[] = [];
  let lastLoud = -Infinity;
  for (let i = 0; i < buf.length / 2; i++) {
    const v = Math.abs(buf.readInt16LE(i * 2)) / 32768;
    if (v > thr) {
      const t = t0 + i / 48000;
      if (t - lastLoud > gap) onsets.push(t);
      lastLoud = t;
    }
  }
  return onsets;
}

/**
 * Sound onsets (s) placed by each decoded frame's own timestamp (ffmpeg silencedetect).
 * The threshold sits well above codec pre-echo. Includes a final entry at end of file.
 */
export function audioOnsetsByTimestamp(file: string, gap = 0.3): number[] {
  const out = String(spawnSync(FF, ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', `silencedetect=n=-16dB:d=${gap}`, '-f', 'null', '-']).stderr);
  return [...out.matchAll(/silence_end: (-?[\d.]+)/g)].map((m) => parseFloat(m[1]));
}
