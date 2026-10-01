import type { ShapeKind } from '@/core/types';

/**
 * In-app drag payloads (library → timeline/preview). The browser only exposes
 * drag data on drop, so the active payload is also kept in a module variable
 * for dragover feedback.
 */

export const DND_TYPE = 'application/x-cutline';

export type DragPayload =
  | { kind: 'assets'; ids: string[] }
  | { kind: 'text'; preset: string }
  | { kind: 'shape'; shape: ShapeKind; fullFrame?: boolean; fill?: string; fill2?: string | null }
  | { kind: 'adjustment' }
  | { kind: 'transition'; type: string }
  | { kind: 'effect'; type: string }
  | { kind: 'filter'; id: string };

let current: DragPayload | null = null;

export function startDrag(e: React.DragEvent, payload: DragPayload, preview?: HTMLElement | null) {
  current = payload;
  e.dataTransfer.setData(DND_TYPE, JSON.stringify(payload));
  e.dataTransfer.effectAllowed = 'copy';
  if (preview) e.dataTransfer.setDragImage(preview, 20, 20);
}

export function endDrag() {
  current = null;
}

export function currentDrag(): DragPayload | null {
  return current;
}

export function readDrag(e: React.DragEvent | DragEvent): DragPayload | null {
  try {
    const raw = e.dataTransfer?.getData(DND_TYPE);
    if (raw) return JSON.parse(raw) as DragPayload;
  } catch {
    /* ignore */
  }
  return current;
}

export function isInternalDrag(e: React.DragEvent | DragEvent): boolean {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes(DND_TYPE);
}
