import { startBusy, withWakeLock } from '@/state/busy';
import { uid } from '@/core/ids';
import type { Project } from '@/core/types';
import { media } from '@/media/registry';
import { deleteFile, DIRS, getFile } from '@/storage/opfs';
import type { ExportOptions, ExportStartMessage, ExportWorkerMessage } from './types';

/**
 * Main-thread side of export: gathers media handles, starts the export
 * worker, relays progress, and hands back the finished file.
 */

export interface ExportProgress {
  phase: 'preparing' | 'rendering' | 'finalizing';
  frame: number;
  totalFrames: number;
  fps: number;
  elapsed: number;
}

export interface ExportResult {
  file: File | null;
  /** True when written directly to a user-chosen location. */
  savedToDisk: boolean;
  bytes: number;
  elapsed: number;
  videoCodec: string | null;
  audioCodec: string | null;
  /** Delete the rendered file from browser storage once it has been downloaded. */
  discard?: () => void;
}

export class ExportError extends Error {}

/** Problems that must be fixed before exporting (missing media, analysis in progress). */
export function preflight(p: Project, o: ExportOptions): string[] {
  const issues: string[] = [];
  const used = new Set<string>();
  for (const c of Object.values(p.clips)) {
    if ('assetId' in c && c.start < o.end && c.start + c.duration > o.start && !c.disabled) used.add(c.assetId);
  }
  for (const id of used) {
    const a = p.assets[id];
    if (!a) continue;
    if (!media.hasFile(id) || a.status === 'missing') issues.push(`“${a.name}” is offline. Relink it in the Media panel.`);
    else if (a.status === 'error') issues.push(`“${a.name}” could not be decoded.`);
    else if (o.includeAudio && a.audio && !a.audio.conformed) {
      const p2 = media.getProgress(id);
      issues.push(
        p2
          ? `Audio for “${a.name}” is still being prepared (${Math.round(p2.value * 100)}%). Try again in a moment.`
          : `Audio for “${a.name}” isn’t ready. Reload the page to prepare it again, or export without audio.`,
      );
    }
  }
  if (o.end - o.start <= 0) issues.push('The timeline is empty — add some media first.');
  return issues;
}

export function runExport(
  project: Project,
  options: ExportOptions,
  handle: FileSystemFileHandle | null,
  onProgress: (p: ExportProgress) => void,
): { promise: Promise<ExportResult>; cancel: () => void } {
  const worker = new Worker(new URL('../workers/export.worker.ts', import.meta.url), { type: 'module', name: 'export' });
  let cancel = () => {};
  const done = startBusy('an export');
  const promise = withWakeLock(async () => {
    const files: ExportStartMessage['files'] = {};
    const pcm: ExportStartMessage['pcm'] = {};
    const fonts: ExportStartMessage['fonts'] = {};
    for (const a of Object.values(project.assets)) {
      const f = media.getFile(a.id);
      if (!f) continue;
      if (a.kind === 'font' && a.font) fonts[a.font.family] = await f.arrayBuffer();
      else files[a.id] = f;
      if (a.audio?.conformed) {
        const pf = media.getPcmBlob(a.id) ?? (await getFile(DIRS.pcm, a.id + '.pcm'));
        if (pf) pcm[a.id] = { file: pf as File, sampleRate: a.audio.sampleRate, channels: a.audio.channels >= 2 ? 2 : 1 };
        const nr = media.getPcmBlob(a.id, 'nr');
        if (nr) pcm[`${a.id}:nr`] = { file: nr as File, sampleRate: a.audio.sampleRate, channels: a.audio.channels >= 2 ? 2 : 1 };
      }
    }
    const opfsName = `${uid('exp')}.${options.container}`;
    const target: ExportStartMessage['target'] = handle ? { kind: 'handle', handle } : { kind: 'opfs', name: opfsName };
    return await new Promise<ExportResult>((resolve, reject) => {
      cancel = () => worker.postMessage({ type: 'cancel' });
      worker.onmessage = async (ev: MessageEvent<ExportWorkerMessage>) => {
        const m = ev.data;
        if (m.type === 'progress') onProgress(m);
        else if (m.type === 'done') {
          const file = handle ? null : m.buffer ? new File([m.buffer], options.fileName, { type: m.mimeType.split(';')[0] }) : await getFile(DIRS.exports, opfsName);
          const stored = !handle && !m.buffer;
          resolve({
            file,
            savedToDisk: !!handle,
            bytes: m.bytes,
            elapsed: m.elapsed,
            videoCodec: m.videoCodec,
            audioCodec: m.audioCodec,
            // A download in progress still reads the file: give it time before deleting.
            discard: stored ? () => void setTimeout(() => void deleteFile(DIRS.exports, opfsName).catch(() => {}), 120_000) : undefined,
          });
        } else if (m.type === 'cancelled') reject(new ExportError('cancelled'));
        else if (m.type === 'error') reject(new ExportError(m.message));
      };
      worker.onerror = (e) => reject(new ExportError(e.message || 'The export worker crashed.'));
      const msg: ExportStartMessage = { type: 'start', project, files, pcm, fonts, options, target };
      worker.postMessage(msg);
    });
  }).finally(() => {
    worker.terminate();
    done();
  });
  return { promise, cancel: () => cancel() };
}
