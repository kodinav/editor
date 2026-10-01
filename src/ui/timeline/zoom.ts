import { projectDuration } from '@/core/project';
import { editor, usePlayback } from '@/state/store';

export const MIN_PX_PER_SEC = 0.5;
export const MAX_PX_PER_SEC = 2400;

/** Width (px) of the scrollable lanes viewport, published by the Timeline component. */
export const timelineViewport = { width: 800, headerWidth: 168 };

/** Zoom keeping the playhead (or a given anchor time) at the same screen position. */
export function zoomTimeline(factor: number, anchorTime?: number) {
  const s = editor();
  const old = s.pxPerSec;
  const next = Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, old * factor));
  if (next === old) return;
  const t = anchorTime ?? usePlayback.getState().time;
  const screenX = t * old - s.scrollX;
  const visible = screenX >= 0 && screenX <= timelineViewport.width;
  const anchorX = visible ? screenX : timelineViewport.width / 2;
  const anchorT = visible ? t : (s.scrollX + anchorX) / old;
  const scrollX = Math.max(0, anchorT * next - anchorX);
  editor().set('pxPerSec', next);
  editor().set('scrollX', scrollX);
}

export function zoomToFit() {
  const d = projectDuration(editor().project);
  const w = Math.max(200, timelineViewport.width - 40);
  // Don't zoom in absurdly far on very short timelines.
  const px = d > 0 ? Math.min(w / d, 240) : 80;
  editor().set('pxPerSec', Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, px)));
  editor().set('scrollX', 0);
}
