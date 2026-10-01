import type { AnalyzeDone, AnalyzeError, AnalyzeProgress, AnalyzeRequest } from '@/workers/analyze.worker';
import { uid } from '@/core/ids';

/**
 * Client for the background analysis worker. Jobs run with bounded
 * concurrency so a 50-file drop doesn't spawn 50 decoders at once.
 */

export type AnalyzeResult = AnalyzeDone;

interface Job {
  req: AnalyzeRequest;
  onProgress?: (stage: AnalyzeProgress['stage'], value: number) => void;
  resolve: (r: AnalyzeDone) => void;
  reject: (e: Error) => void;
}

const MAX_CONCURRENT = 2;

class AnalysisClient {
  private worker: Worker | null = null;
  private queue: Job[] = [];
  private active = new Map<string, Job>();

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/analyze.worker.ts', import.meta.url), { type: 'module', name: 'analyze' });
      this.worker.onmessage = (ev: MessageEvent<AnalyzeDone | AnalyzeProgress | AnalyzeError>) => {
        const msg = ev.data;
        const job = this.active.get(msg.jobId);
        if (!job) return;
        if (msg.type === 'progress') {
          job.onProgress?.(msg.stage, msg.value);
          return;
        }
        this.active.delete(msg.jobId);
        if (msg.type === 'done') job.resolve(msg);
        else job.reject(new Error(msg.message));
        this.pump();
      };
      this.worker.onerror = (e) => {
        console.error('Analysis worker crashed', e);
        for (const job of this.active.values()) job.reject(new Error('Media analysis crashed.'));
        this.active.clear();
        this.worker?.terminate();
        this.worker = null;
        this.pump();
      };
    }
    return this.worker;
  }

  private pump() {
    while (this.active.size < MAX_CONCURRENT && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active.set(job.req.jobId, job);
      this.ensureWorker().postMessage(job.req);
    }
  }

  analyze(
    assetId: string,
    file: File,
    what: { copy: boolean; thumbs: boolean; audio: boolean },
    onProgress?: Job['onProgress'],
  ): { promise: Promise<AnalyzeDone>; cancel: () => void } {
    const jobId = uid('job');
    let cancel = () => {};
    const promise = new Promise<AnalyzeDone>((resolve, reject) => {
      const job: Job = { req: { type: 'analyze', jobId, assetId, file, ...what }, onProgress, resolve, reject };
      this.queue.push(job);
      cancel = () => {
        const qi = this.queue.indexOf(job);
        if (qi >= 0) {
          this.queue.splice(qi, 1);
          reject(new Error('cancelled'));
        } else if (this.active.has(jobId)) {
          this.worker?.postMessage({ type: 'cancel', jobId });
        }
      };
      this.pump();
    });
    return { promise, cancel };
  }
}

export const analysis = new AnalysisClient();
