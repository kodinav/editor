/**
 * Origin Private File System helpers. Media bytes and derived audio live here:
 * private to this site, never uploaded, and they survive page reloads.
 * Works on the main thread and inside workers.
 */

export const DIRS = {
  media: 'media',
  pcm: 'pcm',
  exports: 'exports',
} as const;

export function opfsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';
}

let usable: Promise<boolean> | null = null;
/** Whether OPFS actually works here (it exists but throws in some private-browsing modes). */
export function opfsUsable(): Promise<boolean> {
  if (!usable) {
    usable = (async () => {
      if (!opfsSupported()) return false;
      try {
        const root = await navigator.storage.getDirectory();
        await root.getDirectoryHandle(DIRS.media, { create: true });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return usable;
}

async function dir(name: string): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}

export async function getFile(folder: string, name: string): Promise<File | null> {
  try {
    const d = await dir(folder);
    const h = await d.getFileHandle(name);
    return await h.getFile();
  } catch {
    return null;
  }
}

export async function getFileHandle(folder: string, name: string, create = false): Promise<FileSystemFileHandle | null> {
  try {
    const d = await dir(folder);
    return await d.getFileHandle(name, { create });
  } catch {
    return null;
  }
}

export async function deleteFile(folder: string, name: string): Promise<void> {
  try {
    const d = await dir(folder);
    await d.removeEntry(name);
  } catch {
    /* already gone */
  }
}

export async function listFiles(folder: string): Promise<string[]> {
  const d = await dir(folder);
  const names: string[] = [];
  for await (const [name] of d.entries()) names.push(name);
  return names;
}

/**
 * Stream a Blob into OPFS. Uses a writable stream when available (main thread
 * in Chromium/Firefox/Safari 18.2+); falls back to sync access handles in workers.
 */
export async function writeBlob(
  folder: string,
  name: string,
  blob: Blob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const d = await dir(folder);
  const h = await d.getFileHandle(name, { create: true });
  const total = blob.size || 1;
  if ('createWritable' in h) {
    const writable = await (h as FileSystemFileHandle).createWritable();
    try {
      const reader = blob.stream().getReader();
      let written = 0;
      for (;;) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value as Uint8Array<ArrayBuffer>);
        written += value.byteLength;
        onProgress?.(written / total);
      }
      await writable.close();
    } catch (e) {
      try {
        await writable.abort();
      } catch {
        /* ignore */
      }
      await deleteFile(folder, name);
      throw e;
    }
    return;
  }
  throw new Error('This browser cannot write files to local storage.');
}

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

export async function storageInfo(): Promise<StorageInfo | null> {
  if (!navigator.storage?.estimate) return null;
  const est = await navigator.storage.estimate();
  const persisted = (await navigator.storage.persisted?.()) ?? false;
  return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
}

/** Ask the browser not to evict our data under storage pressure. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
