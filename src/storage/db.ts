import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Project } from '@/core/types';

/**
 * IndexedDB holds project documents, a lightweight index for the project
 * browser, and small derived artifacts (thumbnail sprites, waveform peaks).
 * Large media bytes live in OPFS instead (see opfs.ts).
 */

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  createdAt: number;
  duration: number;
  width: number;
  height: number;
  /** Small JPEG of a representative frame. */
  thumbnail?: Blob;
}

export interface ThumbSprite {
  assetId: string;
  /** Sprite sheet JPEG. */
  blob: Blob;
  cols: number;
  rows: number;
  count: number;
  thumbWidth: number;
  thumbHeight: number;
  /** Seconds between thumbnails. */
  interval: number;
  /** Source timestamp of thumbnail 0. */
  start: number;
}

export interface Peaks {
  assetId: string;
  /** Peaks per second. */
  rate: number;
  /** 0..255 max-abs amplitude per bucket. */
  data: Uint8Array;
}

/**
 * Binary payloads are stored as ArrayBuffers, not Blobs: Safari's private
 * browsing mode (and some embedded WebViews) reject Blobs in IndexedDB.
 */
interface StoredBinary {
  data: ArrayBuffer;
  type: string;
}

type StoredMeta = Omit<ProjectMeta, 'thumbnail'> & { thumbnail?: StoredBinary | Blob };
type StoredThumbs = Omit<ThumbSprite, 'blob'> & { blob: StoredBinary | Blob };

async function toStored(b: Blob): Promise<StoredBinary> {
  return { data: await b.arrayBuffer(), type: b.type };
}

function fromStored(v: StoredBinary | Blob | undefined): Blob | undefined {
  if (!v) return undefined;
  if (v instanceof Blob) return v;
  return new Blob([v.data], { type: v.type });
}

interface CutlineDB extends DBSchema {
  projects: { key: string; value: Project };
  meta: { key: string; value: StoredMeta; indexes: { updatedAt: number } };
  thumbs: { key: string; value: StoredThumbs };
  peaks: { key: string; value: Peaks };
  kv: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<CutlineDB>> | null = null;

export function db(): Promise<IDBPDatabase<CutlineDB>> {
  if (!dbPromise) {
    dbPromise = openDB<CutlineDB>('cutline', 1, {
      upgrade(d) {
        d.createObjectStore('projects');
        const meta = d.createObjectStore('meta', { keyPath: 'id' });
        meta.createIndex('updatedAt', 'updatedAt');
        d.createObjectStore('thumbs', { keyPath: 'assetId' });
        d.createObjectStore('peaks', { keyPath: 'assetId' });
        d.createObjectStore('kv');
      },
      blocked() {
        console.warn('Database upgrade blocked by another tab.');
      },
    });
  }
  return dbPromise;
}

export async function saveProject(p: Project, meta: ProjectMeta): Promise<void> {
  const stored: StoredMeta = { ...meta, thumbnail: meta.thumbnail ? await toStored(meta.thumbnail) : undefined };
  const d = await db();
  const tx = d.transaction(['projects', 'meta'], 'readwrite');
  await Promise.all([tx.objectStore('projects').put(p, p.id), tx.objectStore('meta').put(stored), tx.done]);
}

export async function getProjectMeta(id: string): Promise<ProjectMeta | undefined> {
  const m = await (await db()).get('meta', id);
  return m ? { ...m, thumbnail: fromStored(m.thumbnail) } : undefined;
}

export async function loadProject(id: string): Promise<Project | undefined> {
  return (await db()).get('projects', id);
}

export async function listProjects(): Promise<ProjectMeta[]> {
  const all = await (await db()).getAll('meta');
  return all.map((m) => ({ ...m, thumbnail: fromStored(m.thumbnail) })).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function deleteProjectRecord(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['projects', 'meta'], 'readwrite');
  await Promise.all([tx.objectStore('projects').delete(id), tx.objectStore('meta').delete(id), tx.done]);
}

export async function allProjects(): Promise<Project[]> {
  return (await db()).getAll('projects');
}

export async function getThumbs(assetId: string): Promise<ThumbSprite | undefined> {
  const t = await (await db()).get('thumbs', assetId);
  return t ? { ...t, blob: fromStored(t.blob)! } : undefined;
}

/** Thumbnails are a cache: failing to persist one must never fail an import. */
export async function putThumbs(t: ThumbSprite): Promise<void> {
  try {
    await (await db()).put('thumbs', { ...t, blob: await toStored(t.blob) });
  } catch (e) {
    console.warn('Could not store thumbnails', e);
  }
}

export async function getPeaks(assetId: string): Promise<Peaks | undefined> {
  return (await db()).get('peaks', assetId);
}

export async function putPeaks(p: Peaks): Promise<void> {
  try {
    await (await db()).put('peaks', p);
  } catch (e) {
    console.warn('Could not store waveform', e);
  }
}

export async function deleteDerived(assetId: string): Promise<void> {
  const d = await db();
  await Promise.all([d.delete('thumbs', assetId), d.delete('peaks', assetId)]);
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key);
}
