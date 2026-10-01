/** Time helpers. All timeline values are seconds; frames are derived from project fps. */

export const EPS = 1e-6;

export function frameDuration(fps: number): number {
  return 1 / fps;
}

export function toFrame(t: number, fps: number): number {
  return Math.round(t * fps + 1e-9);
}

export function fromFrame(frame: number, fps: number): number {
  return frame / fps;
}

/** Round a time to the nearest frame boundary. */
export function snapToFrame(t: number, fps: number): number {
  return Math.round(t * fps + 1e-9) / fps;
}

export function floorToFrame(t: number, fps: number): number {
  return Math.floor(t * fps + 1e-6) / fps;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** HH:MM:SS:FF timecode. */
export function formatTimecode(t: number, fps: number): string {
  const sign = t < 0 ? '-' : '';
  const totalFrames = Math.abs(toFrame(t, fps));
  const fpsInt = Math.round(fps);
  const frames = totalFrames % fpsInt;
  const totalSeconds = Math.floor(totalFrames / fpsInt);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}:${pad(frames)}`;
}

/** Compact human time, e.g. "1:05.2" or "12.0s". */
export function formatShort(t: number): string {
  if (!isFinite(t)) return '–';
  const neg = t < 0;
  t = Math.abs(t);
  if (t < 60) return `${neg ? '-' : ''}${t.toFixed(1)}s`;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  if (m < 60) return `${neg ? '-' : ''}${m}:${s.toFixed(1).padStart(4, '0')}`;
  const h = Math.floor(m / 60);
  return `${neg ? '-' : ''}${h}:${pad(m % 60)}:${pad(Math.floor(s))}`;
}

/** Duration label like "0:12" or "1:02:03". */
export function formatDuration(t: number): string {
  if (!isFinite(t) || t < 0) return '–';
  const total = Math.round(t);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Parse "HH:MM:SS:FF", "MM:SS", "SS.s", "1m20s" style input into seconds. */
export function parseTime(input: string, fps: number): number | null {
  const s = input.trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?s?$/.test(s)) return parseFloat(s);
  const parts = s.split(':').map((p) => p.trim());
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 4) return nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / fps;
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  return null;
}

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}
