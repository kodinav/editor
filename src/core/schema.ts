import { z } from 'zod';
import { DEFAULT_SETTINGS } from './project';
import { clampNumber, cleanString, MAX_TIME, obj, sanitizeAsset, sanitizeClip, sanitizeMarkers, sanitizeRange, sanitizeTrack } from './sanitize';
import { PROJECT_SCHEMA_VERSION, type Asset, type Clip, type Project, type Track } from './types';

/**
 * Validation and forward-migration for project documents. Anything loaded
 * from disk or from an imported project file passes through here, so the rest
 * of the app can rely on the invariants in types.ts.
 */

const finite = z.number().refine(Number.isFinite, 'must be a finite number');

const settingsSchema = z.object({
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  fps: z.number().min(1).max(240),
  background: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
  sampleRate: z.number().int().min(8000).max(192000),
});

const assetSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(['video', 'audio', 'image', 'font']),
    name: z.string().max(512),
    mimeType: z.string().max(256),
    size: finite,
    duration: finite,
    status: z.enum(['processing', 'ready', 'missing', 'error']),
    stored: z.boolean(),
  })
  .passthrough();

const trackSchema = z
  .object({
    id: z.string().min(1).max(64),
    kind: z.enum(['video', 'audio', 'caption']),
    name: z.string().max(200),
  })
  .passthrough();

const clipSchema = z
  .object({
    id: z.string().min(1).max(64),
    trackId: z.string().min(1).max(64),
    type: z.enum(['video', 'audio', 'image', 'text', 'shape', 'adjustment', 'caption']),
    start: finite.min(0).max(MAX_TIME),
    duration: finite.positive().max(MAX_TIME),
  })
  .passthrough();

const projectSchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().max(300),
    settings: settingsSchema,
    assets: z.record(z.string(), assetSchema),
    tracks: z.array(trackSchema).max(200),
    clips: z.record(z.string(), clipSchema),
  })
  .passthrough()
  .refine((p) => Object.keys(p.clips).length <= 100_000 && Object.keys(p.assets).length <= 20_000, 'has too many items');

export class ProjectValidationError extends Error {}

/** Validate untrusted input and upgrade it to the current schema. */
export function parseProject(raw: unknown): Project {
  const res = projectSchema.safeParse(raw);
  if (!res.success) {
    const issue = res.error.issues[0];
    throw new ProjectValidationError(`Invalid project file: ${issue.path.join('.')} ${issue.message}`);
  }
  return migrateProject(res.data as unknown as Project);
}

/**
 * Fill in defaults for fields added after a project was created, and repair
 * anything malformed (see sanitize.ts). Unusable clips and assets are dropped.
 */
export function migrateProject(p: Project): Project {
  const raw = p as unknown as Record<string, unknown>;
  const assets: Record<string, Asset> = {};
  for (const [key, a] of Object.entries(obj(raw.assets))) {
    const clean = sanitizeAsset({ ...obj(a), id: key });
    if (clean) assets[key] = clean;
  }
  // Unique tracks, visual (video/caption) before audio.
  const seen = new Set<string>();
  const tracks: Track[] = [];
  for (const t of Array.isArray(raw.tracks) ? raw.tracks : []) {
    const clean = sanitizeTrack(obj(t));
    if (seen.has(clean.id)) continue;
    seen.add(clean.id);
    tracks.push(clean);
  }
  tracks.sort((a, b) => Number(a.kind === 'audio') - Number(b.kind === 'audio'));
  const kindOf = new Map(tracks.map((t) => [t.id, t.kind]));
  const clips: Record<string, Clip> = {};
  for (const [key, c] of Object.entries(obj(raw.clips))) {
    const clean = sanitizeClip({ ...obj(c), id: key }, assets);
    if (!clean) continue;
    const kind = kindOf.get(clean.trackId);
    const fits = clean.type === 'audio' ? kind === 'audio' : clean.type === 'caption' ? kind === 'caption' : kind === 'video';
    if (fits) clips[key] = clean;
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: p.id,
    name: cleanString(p.name, 'Untitled project', 300),
    createdAt: clampNumber(p.createdAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    updatedAt: clampNumber(p.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    settings: { ...DEFAULT_SETTINGS, ...p.settings },
    assets,
    tracks,
    clips,
    markers: sanitizeMarkers(p.markers),
    ...sanitizeRange(p.inPoint, p.outPoint),
    masterVolume: clampNumber(p.masterVolume, 1, 0, 16),
  };
}
