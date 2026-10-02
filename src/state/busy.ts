import { editor } from './store';

/**
 * Long-running work that leaving the page would destroy (an export, a
 * recording, transcription). While any is running, or the project has changes
 * that couldn't be saved, the browser asks before the tab is closed or
 * reloaded.
 */
const running = new Map<number, string>();
let seq = 0;

/** Register work in progress; call the returned function when it ends. */
export function startBusy(what: string): () => void {
  const id = ++seq;
  running.set(id, what);
  return () => void running.delete(id);
}

/** Human-readable list of work in progress, or null. */
export function busyReason(): string | null {
  return running.size ? [...new Set(running.values())].join(', ') : null;
}

export function installLeaveGuard() {
  window.addEventListener('beforeunload', (e) => {
    const s = editor();
    const unsaved = !s.readOnlyReason && (s.saveState === 'error' || s.saveState === 'saving');
    if (busyReason() || unsaved) {
      e.preventDefault();
      e.returnValue = ''; // older browsers need this to show the prompt
    }
  });
}

/** Keep the screen (and with it the GPU and encoders) awake while `fn` runs. */
export async function withWakeLock<T>(fn: () => Promise<T>): Promise<T> {
  let lock: { release(): Promise<void> } | null = null;
  try {
    lock = (await (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen')) ?? null;
  } catch {
    /* not allowed or unsupported: carry on */
  }
  try {
    return await fn();
  } finally {
    void lock?.release().catch(() => {});
  }
}
