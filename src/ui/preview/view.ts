import { useEffect, type RefObject } from 'react';
import { create } from 'zustand';

/**
 * Preview zoom and pan. `zoom` is screen pixels per project pixel; null means
 * "fit the frame in the pane". `x`/`y` move the frame from the centre of the
 * pane (screen pixels). Zooming out leaves room around the frame, so handles
 * of layers larger than the frame can be reached; zooming in is for detail.
 */
interface PreviewView {
  zoom: number | null;
  x: number;
  y: number;
  /** The scale "fit" currently works out to (kept up to date by the pane). */
  fit: number;
  set(v: Partial<Pick<PreviewView, 'zoom' | 'x' | 'y' | 'fit'>>): void;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export const usePreviewView = create<PreviewView>()((set) => ({
  zoom: null,
  x: 0,
  y: 0,
  fit: 1,
  set: (v) => set(v),
}));

export function fitPreview() {
  usePreviewView.getState().set({ zoom: null, x: 0, y: 0 });
}

/** Set the zoom, keeping the point at (px, py) — relative to the pane's centre — where it is. */
export function zoomPreviewTo(zoom: number, px = 0, py = 0) {
  const v = usePreviewView.getState();
  const from = v.zoom ?? v.fit;
  const to = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  const k = to / from;
  v.set({ zoom: to, x: px - (px - v.x) * k, y: py - (py - v.y) * k });
}

export function zoomPreviewBy(factor: number, px = 0, py = 0) {
  const v = usePreviewView.getState();
  zoomPreviewTo((v.zoom ?? v.fit) * factor, px, py);
}

function panBy(dx: number, dy: number) {
  const v = usePreviewView.getState();
  v.set({ zoom: v.zoom ?? v.fit, x: v.x + dx, y: v.y + dy });
}

/**
 * Wheel, trackpad, middle-button and two-finger navigation for the preview pane:
 * Ctrl/⌘ + wheel (or a trackpad pinch) zooms at the pointer, the wheel pans once
 * zoomed, a middle-button drag pans, and two fingers pinch and pan on touch screens.
 */
export function usePreviewNavigation(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const centre = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      return { x: clientX - (r.left + r.width / 2), y: clientY - (r.top + r.height / 2) };
    };
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const c = centre(e.clientX, e.clientY);
        zoomPreviewBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), c.x, c.y);
      } else if (usePreviewView.getState().zoom !== null) {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : 1;
        panBy(-(e.shiftKey ? e.deltaY : e.deltaX) * unit, -(e.shiftKey ? 0 : e.deltaY) * unit);
      }
    };

    // Middle-button drag pans.
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return touchDown(e);
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      let last = { x: e.clientX, y: e.clientY };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        panBy(ev.clientX - last.x, ev.clientY - last.y);
        last = { x: ev.clientX, y: ev.clientY };
      };
      const up = (ev: PointerEvent) => {
        if (ev.pointerId !== e.pointerId) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    };

    // Two fingers: pinch to zoom, move together to pan.
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; mid: { x: number; y: number } } | null = null;
    const measure = () => {
      const [a, b] = [...touches.values()];
      return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mid: centre((a.x + b.x) / 2, (a.y + b.y) / 2) };
    };
    const touchDown = (e: PointerEvent) => {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size !== 2) return;
      // A second finger turns a layer drag into navigation: call off whatever the first finger started.
      for (const id of touches.keys()) if (id !== e.pointerId) window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: id, pointerType: 'touch' }));
      e.stopPropagation();
      pinch = measure();
    };
    const touchMove = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!pinch || touches.size !== 2) return;
      e.stopPropagation();
      const now = measure();
      zoomPreviewBy(now.dist / pinch.dist, pinch.mid.x, pinch.mid.y);
      panBy(now.mid.x - pinch.mid.x, now.mid.y - pinch.mid.y);
      pinch = now;
    };
    const touchUp = (e: PointerEvent) => {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinch = null;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onDown, true);
    window.addEventListener('pointermove', touchMove, true);
    window.addEventListener('pointerup', touchUp, true);
    window.addEventListener('pointercancel', touchUp, true);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointermove', touchMove, true);
      window.removeEventListener('pointerup', touchUp, true);
      window.removeEventListener('pointercancel', touchUp, true);
    };
  }, [ref]);
}
