import { uid } from '@/core/ids';
import { parseSubtitles } from '@/core/captions';
import { addTrack, findOrCreateTrack, frameCues, makeRoomFor, q } from '@/core/ops';
import {
  clipEnd,
  createAudioClip,
  createCaptionClip,
  createImageClip,
  createVideoClip,
  scaledCaptionStyle,
} from '@/core/project';
import type { Asset, Clip, Project } from '@/core/types';
import { registerCustomFont } from '@/engine/fonts';
import { analysis } from '@/media/analysis';
import { categorize, normalizeImageFile, probeAV, ProbeError } from '@/media/probe';
import { media, MAX_IMAGE_DIM } from '@/media/registry';
import { makeImageThumb } from '@/media/imageThumb';
import { probeAnimation } from '@/media/animatedImage';
import { getProjectMeta, loadProject as loadProjectRecord, putPeaks, putThumbs, saveProject } from '@/storage/db';
import { DIRS, getFile, opfsUsable, requestPersistence } from '@/storage/opfs';
import { restoreNoiseReduction } from './denoiseTools';
import { editor, toast, usePlayback } from './store';

/**
 * Import pipeline. Files become usable as soon as they are probed (using the
 * original File for this session); copying into local storage, audio
 * conforming and thumbnail generation continue in a worker.
 */

export const DEFAULT_IMAGE_DURATION = 5;
/** A first import into an empty project lands on the timeline only for a handful of files. */
const AUTO_PLACE_LIMIT = 8;

export interface ImportOptions {
  /** Place imported media on the timeline at this time/track. */
  place?: { time: number; trackId?: string };
}

function fontFamilyFromFile(name: string): string {
  return name.replace(/\.(ttf|otf|woff2?|)$/i, '').replace(/[-_]+/g, ' ').replace(/["\\]/g, '').trim().slice(0, 60) || 'Custom font';
}

/**
 * The file's audio can't be decoded: a video carries on silent, an audio file
 * is marked as failed. Either way nothing waits on audio that will never come.
 */
export function audioUnusable(id: string, reason: string) {
  const a = editor().project.assets[id];
  if (!a) return;
  if (a.kind === 'audio') {
    updateAsset(id, { status: 'error', error: `The audio could not be decoded. ${reason}` });
    toast({ kind: 'error', message: `“${a.name}” could not be decoded.`, detail: reason });
  } else {
    updateAsset(id, { audio: undefined });
    toast({ kind: 'warning', message: `Audio in “${a.name}” could not be decoded; the video will be silent.`, detail: reason });
  }
}

function updateAsset(id: string, patch: Partial<Asset>) {
  editor().silent((d) => {
    const a = d.assets[id];
    if (a) Object.assign(a, patch);
  });
}

/** Snap common frame rates (e.g. 29.97 measured as 29.98). */
function normalizeFps(fps: number): number {
  const common = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  let best = 30;
  for (const c of common) if (Math.abs(c - fps) < Math.abs(best - fps)) best = c;
  // Variable-rate phone footage averages odd values; slow-motion runs at 120/240 fps.
  return Math.abs(best - fps) < 0.6 ? best : fps > 60 ? 60 : 30;
}

async function prepareAsset(file: File, kind: Asset['kind']): Promise<{ asset: Asset; file: File; warnings: string[] } | null> {
  const id = uid('ast');
  const asset: Asset = {
    id,
    kind,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    lastModified: file.lastModified,
    duration: 0,
    status: 'processing',
    stored: false,
    createdAt: Date.now(),
  };
  editor().silent((d) => void (d.assets[id] = asset));
  media.setFile(id, file);
  media.setProgress(id, { stage: 'probe', value: 0 });
  let usedFile = file;
  const warnings: string[] = [];
  try {
    if (kind === 'image') {
      // SVGs are stored as PNG so every later step (workers, export) sees plain pixels.
      const { file: normalized, bitmap: bmp, converted } = await normalizeImageFile(file, MAX_IMAGE_DIM);
      if (converted) {
        usedFile = normalized;
        media.setFile(id, usedFile);
      }
      const thumb = await makeImageThumb(id, bmp);
      await putThumbs(thumb);
      media.setThumbs(id, thumb);
      const anim = converted ? null : await probeAnimation(file);
      updateAsset(id, {
        image: { width: bmp.width, height: bmp.height, animated: !!anim },
        duration: anim ? anim.duration : 0,
        status: 'ready',
        mimeType: usedFile.type,
        size: usedFile.size,
      });
      media.setMeta(editor().project.assets[id]);
      media.setImage(id, bmp);
    } else if (kind === 'font') {
      const family = fontFamilyFromFile(file.name);
      const buf = await file.arrayBuffer();
      try {
        await new FontFace(family, buf.slice(0)).load();
      } catch {
        throw new ProbeError('This font file could not be read.');
      }
      // Record the family first: the project's fonts are kept in sync with its assets.
      updateAsset(id, { font: { family } });
      await registerCustomFont(family, buf);
      updateAsset(id, { status: 'ready' });
    } else {
      const info = await probeAV(file, kind === 'audio' ? 'audio' : 'video');
      warnings.push(...info.warnings);
      updateAsset(id, {
        kind: info.kind,
        duration: info.duration,
        video: info.video,
        audio: info.audio ? { ...info.audio, conformed: false } : undefined,
        status: 'ready',
      });
    }
  } catch (e) {
    const msg = e instanceof ProbeError ? e.message : `Could not import this file: ${(e as Error).message ?? e}`;
    updateAsset(id, { status: 'error', error: msg });
    media.setProgress(id, null);
    toast({ kind: 'error', message: `“${file.name}” could not be imported.`, detail: msg });
    return null;
  }
  media.setProgress(id, null);
  return { asset: editor().project.assets[id], file: usedFile, warnings };
}

async function startBackgroundWork(asset: Asset, file: File) {
  const id = asset.id;
  const wantCopy = await opfsUsable();
  const wantThumbs = asset.kind === 'video';
  const wantAudio = !!asset.audio;
  if (!wantCopy && !wantThumbs && !wantAudio) return;
  media.setProgress(id, { stage: wantAudio ? 'audio' : wantThumbs ? 'thumbs' : 'copy', value: 0 });
  const projectId = editor().project.id;
  const job = analysis.analyze(id, file, { copy: wantCopy, thumbs: wantThumbs, audio: wantAudio }, (stage, value) =>
    media.setProgress(id, { stage, value }),
  );
  job.promise
    .then(async (res) => {
      // Thumbnails and waveforms are stored per asset, whichever project is open now.
      if (res.peaks) await putPeaks({ assetId: id, rate: res.peaks.rate, data: res.peaks.data });
      if (res.thumbs) await putThumbs({ assetId: id, ...res.thumbs });
      if (editor().project.id !== projectId) {
        // The user switched projects meanwhile: record the result in the saved one, so its
        // media isn't offline (and its audio isn't re-prepared) when it's opened again.
        const saved = await loadProjectRecord(projectId);
        const meta = await getProjectMeta(projectId);
        const a = saved?.assets[id];
        if (saved && meta && a) {
          if (res.stored) a.stored = true;
          if (res.pcm && !res.pcmBuffer && a.audio) a.audio.conformed = true;
          await saveProject(saved, meta);
        }
        return;
      }
      if (!editor().project.assets[id]) return;
      if (res.stored) {
        updateAsset(id, { stored: true });
        const f = await getFile(DIRS.media, id);
        if (f) media.setFile(id, new File([f], asset.name, { type: editor().project.assets[id]?.mimeType ?? file.type, lastModified: asset.lastModified }));
      } else if (res.storeError) {
        toast({
          kind: 'warning',
          message: `“${asset.name}” was not saved to local storage.`,
          detail: `${res.storeError} It will need to be re-linked after reloading the page.`,
          timeout: 10000,
        });
      }
      if (res.pcm) {
        updateAsset(id, { audio: { ...editor().project.assets[id].audio!, conformed: true } });
        if (res.pcmBuffer) media.setMemoryPcm(editor().project.assets[id], res.pcmBuffer);
        else await media.openPcm(editor().project.assets[id]);
        // A relinked file may differ from the one its cleaned audio was made from.
        await restoreNoiseReduction(id, true);
      } else if (res.audioError) {
        audioUnusable(id, res.audioError);
      }
      if (res.peaks) media.setPeaks(id, { assetId: id, rate: res.peaks.rate, data: res.peaks.data });
      if (res.thumbs) media.setThumbs(id, { assetId: id, ...res.thumbs });
    })
    .catch((e) => {
      if (String(e?.message) !== 'cancelled') console.warn('Background analysis failed', e);
    })
    .finally(() => media.setProgress(id, null));
}

/** Create a clip for an asset (not yet inserted). */
export function clipForAsset(p: Project, asset: Asset, trackId: string, start: number): Clip | null {
  const placement = { trackId, start: q(p, start), duration: 0 };
  switch (asset.kind) {
    case 'video':
      return createVideoClip(asset, { ...placement, duration: q(p, asset.duration) || 1 / p.settings.fps });
    case 'audio':
      return createAudioClip(asset, { ...placement, duration: q(p, asset.duration) || 1 / p.settings.fps });
    case 'image':
      // Animated images play at least one full loop.
      return createImageClip(asset, { ...placement, duration: q(p, Math.max(DEFAULT_IMAGE_DURATION, asset.image?.animated ? asset.duration : 0)) });
    default:
      return null;
  }
}

/**
 * Add assets to the timeline, one after another, starting at `time`.
 * Returns the created clip ids.
 */
/** `range`: only that part of the (single) asset's media, e.g. chosen in the source preview. */
export function addAssetsToTimeline(assetIds: string[], time?: number, trackId?: string, range?: { start: number; end: number }): string[] {
  const created: string[] = [];
  editor().commit(assetIds.length > 1 ? 'Add media' : 'Add clip', (d) => {
    // Visual media is laid out one after another; audio gets its own cursor so
    // music/voice lands underneath the footage rather than after it.
    const start = time ?? usePlayback.getState().time;
    let tVisual = start;
    let tAudio = start;
    for (const id of assetIds) {
      const asset = d.assets[id];
      if (!asset || asset.status === 'error' || asset.kind === 'font') continue;
      const kind = asset.kind === 'audio' ? 'audio' : 'video';
      const t = kind === 'audio' ? tAudio : tVisual;
      const part = range && (asset.kind === 'video' || asset.kind === 'audio') ? range : null;
      const dur = part ? part.end - part.start : asset.kind === 'image' ? Math.max(DEFAULT_IMAGE_DURATION, asset.image?.animated ? asset.duration : 0) : asset.duration;
      let track = trackId ? d.tracks.find((x) => x.id === trackId && x.kind === kind) : undefined;
      if (!track || track.locked) track = findOrCreateTrack(d, kind, t, t + dur, kind === 'video' ? lowestVideoTrack(d) : undefined);
      const clip = clipForAsset(d, asset, track.id, t);
      if (!clip) continue;
      if (part && (clip.type === 'video' || clip.type === 'audio')) {
        clip.sourceIn = q(d, part.start);
        clip.duration = Math.max(1 / d.settings.fps, q(d, part.end - part.start));
      }
      d.clips[clip.id] = clip;
      created.push(clip.id);
      makeRoomFor(d, [clip.id], 'overwrite');
      if (kind === 'audio') tAudio = clipEnd(clip);
      else tVisual = clipEnd(clip);
    }
  });
  if (created.length) editor().select(created);
  return created;
}

function lowestVideoTrack(p: Project): string | undefined {
  const vids = p.tracks.filter((t) => t.kind === 'video');
  return vids[vids.length - 1]?.id;
}

async function importSubtitles(file: File) {
  const text = await file.text();
  const cues = parseSubtitles(text);
  if (cues.length === 0) {
    toast({ kind: 'error', message: `No captions found in “${file.name}”.` });
    return;
  }
  editor().commit('Import captions', (d) => {
    // Into an empty caption track if there is one; otherwise its own track (e.g. a second language).
    let track = d.tracks.find((t) => t.kind === 'caption' && !Object.values(d.clips).some((c) => c.trackId === t.id));
    if (!track) {
      track = addTrack(d, 'caption');
      track.name = file.name.replace(/\.(srt|vtt)$/i, '').slice(0, 60) || track.name;
      track.captionStyle = scaledCaptionStyle(d.settings.height);
    }
    for (const c of frameCues(d, cues)) {
      const clip = createCaptionClip({ trackId: track.id, start: c.qStart, duration: c.qEnd - c.qStart }, c.text);
      d.clips[clip.id] = clip;
    }
  });
  toast({ kind: 'success', message: `Imported ${cues.length} captions from “${file.name}”.` });
}

export async function importFiles(files: File[], opts: ImportOptions = {}): Promise<string[]> {
  if (files.length === 0) return [];
  void requestPersistence();
  const wasEmpty = Object.keys(editor().project.clips).length === 0;
  const prepared: Asset[] = [];
  let firstVideo: Asset | null = null;
  const projectFiles: File[] = [];
  for (const file of files) {
    const cat = categorize(file);
    if (cat === 'subtitle') {
      await importSubtitles(file);
      continue;
    }
    if (cat === 'project') {
      projectFiles.push(file);
      continue;
    }
    if (cat === 'unknown') {
      toast({ kind: 'error', message: `“${file.name}” is not a supported media file.`, detail: 'Supported: video (MP4, MOV, WebM, MKV), audio (MP3, WAV, M4A, AAC, OGG, FLAC), images (JPG, PNG, WebP, GIF, AVIF, SVG), fonts, and SRT/VTT captions.' });
      continue;
    }
    const res = await prepareAsset(file, cat);
    if (!res) continue;
    prepared.push(res.asset);
    if (!firstVideo && res.asset.kind === 'video' && res.asset.video) firstVideo = res.asset;
    for (const w of res.warnings) toast({ kind: 'warning', message: `“${file.name}”: ${w}` });
    void startBackgroundWork(res.asset, res.file);
  }
  if (projectFiles.length) {
    const { importProjectPackage } = await import('./projectFile');
    for (const f of projectFiles) await importProjectPackage(f);
  }

  // Smart default: the first footage in an empty project defines its format (unless the user chose one).
  if (wasEmpty && firstVideo?.video && !opts.place && !editor().project.settings.chosen) {
    const v = firstVideo.video;
    const rotated = v.rotation === 90 || v.rotation === 270;
    let w = rotated ? v.height : v.width;
    let h = rotated ? v.width : v.height;
    // Keep dimensions even and within 4K for encoder compatibility.
    const s = Math.min(1, 3840 / Math.max(w, h));
    w = Math.max(16, Math.round((w * s) / 2) * 2);
    h = Math.max(16, Math.round((h * s) / 2) * 2);
    const fps = normalizeFps(v.fps);
    const cur = editor().project.settings;
    if (cur.width !== w || cur.height !== h || cur.fps !== fps) {
      editor().commit('Match footage format', (d) => {
        d.settings.width = w;
        d.settings.height = h;
        d.settings.fps = fps;
      });
      toast({ kind: 'info', message: `Project set to ${w}×${h} at ${fps} fps to match “${firstVideo.name}”.`, detail: 'You can change this anytime in Project settings.' });
    }
  }

  const placeable = prepared.filter((a) => a.kind !== 'font');
  if (opts.place && placeable.length) {
    addAssetsToTimeline(placeable.map((a) => a.id), opts.place.time, opts.place.trackId);
  } else if (wasEmpty && placeable.length > 0 && placeable.length <= AUTO_PLACE_LIMIT) {
    const ids = addAssetsToTimeline(placeable.map((a) => a.id), 0);
    editor().select(ids.slice(0, 1));
  } else if (wasEmpty && placeable.length > AUTO_PLACE_LIMIT) {
    toast({ kind: 'info', message: 'Your media is in the Media panel.', detail: 'Drag files onto the timeline, or press + on a thumbnail to add it at the playhead.' });
  }
  if (prepared.length) {
    toast({ kind: 'success', message: prepared.length === 1 ? `Imported “${prepared[0].name}”.` : `Imported ${prepared.length} files.` });
  }
  return prepared.map((a) => a.id);
}

/** Relink an offline/missing asset to a newly chosen file. */
export async function relinkAsset(assetId: string, file: File): Promise<void> {
  const asset = editor().project.assets[assetId];
  if (!asset) return;
  const cat = categorize(file);
  if (cat !== asset.kind && !(asset.kind === 'audio' && cat === 'video') && !(asset.kind === 'video' && cat === 'video')) {
    toast({ kind: 'error', message: `“${file.name}” is not a ${asset.kind} file.` });
    return;
  }
  // The new file's own details replace the old ones (a different encode may differ in size,
  // frame rate or audio format), and its audio is prepared again.
  let details: Partial<Asset> = {};
  try {
    if (asset.kind === 'video' || asset.kind === 'audio') {
      const info = await probeAV(file, asset.kind);
      if (info.kind !== asset.kind) throw new Error(`“${file.name}” has no ${asset.kind === 'video' ? 'video' : 'audio'} track.`);
      if (Math.abs(info.duration - asset.duration) > 0.5) {
        toast({ kind: 'warning', message: 'The new file has a different duration.', detail: 'Clips were kept as they are; check their timing.' });
      }
      details = { duration: info.duration, video: info.video, audio: info.audio ? { ...info.audio, conformed: false } : undefined };
    } else if (asset.kind === 'image') {
      const { file: normalized, bitmap, converted } = await normalizeImageFile(file, MAX_IMAGE_DIM);
      media.setImage(assetId, bitmap);
      if (converted) file = normalized;
    }
  } catch (e) {
    toast({ kind: 'error', message: 'That file could not be used.', detail: (e as Error).message });
    return;
  }
  media.setFile(assetId, file);
  updateAsset(assetId, { ...details, status: 'ready', error: undefined, stored: false, name: asset.name, mimeType: file.type || asset.mimeType, size: file.size, lastModified: file.lastModified });
  void startBackgroundWork(editor().project.assets[assetId], file);
  toast({ kind: 'success', message: `Relinked “${asset.name}”.` });
}
