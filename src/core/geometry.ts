import type { Crop, FitMode } from './types';

export interface Size {
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Size of a source rectangle after fitting it into the frame. */
export function fittedSize(fit: FitMode, src: Size, frame: Size): Size {
  if (src.w <= 0 || src.h <= 0) return { w: 0, h: 0 };
  switch (fit) {
    case 'contain': {
      const s = Math.min(frame.w / src.w, frame.h / src.h);
      return { w: src.w * s, h: src.h * s };
    }
    case 'cover': {
      const s = Math.max(frame.w / src.w, frame.h / src.h);
      return { w: src.w * s, h: src.h * s };
    }
    case 'fill':
      return { w: frame.w, h: frame.h };
    case 'none':
      return { w: src.w, h: src.h };
  }
}

/**
 * Where a layer lands on the frame. Coordinates are project pixels with the
 * origin at the top-left. `w`/`h` describe the full (uncropped) fitted and
 * scaled rectangle centered at (cx, cy); `vis` is the visible (cropped)
 * sub-rectangle in that rectangle's local coordinates (relative to center).
 */
export interface LayerGeometry {
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
  vis: { x0: number; y0: number; x1: number; y1: number };
}

export function layerGeometry(
  l: { x: number; y: number; scale: number; rotation: number; crop: Crop; fit: FitMode },
  src: Size,
  frame: Size,
): LayerGeometry {
  const fitted = fittedSize(l.fit, src, frame);
  const w = fitted.w * l.scale;
  const h = fitted.h * l.scale;
  const c = l.crop;
  return {
    cx: frame.w / 2 + l.x,
    cy: frame.h / 2 + l.y,
    w,
    h,
    rotation: l.rotation,
    vis: {
      x0: -w / 2 + w * c.left,
      x1: w / 2 - w * c.right,
      y0: -h / 2 + h * c.top,
      y1: h / 2 - h * c.bottom,
    },
  };
}

export function rotatePoint(p: Point, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

/** Corners of the visible rect in frame space: TL, TR, BR, BL. */
export function visibleCorners(g: LayerGeometry): Point[] {
  const pts = [
    { x: g.vis.x0, y: g.vis.y0 },
    { x: g.vis.x1, y: g.vis.y0 },
    { x: g.vis.x1, y: g.vis.y1 },
    { x: g.vis.x0, y: g.vis.y1 },
  ];
  return pts.map((p) => {
    const r = rotatePoint(p, g.rotation);
    return { x: r.x + g.cx, y: r.y + g.cy };
  });
}

/** Frame point -> layer-local point (relative to center, unrotated). */
export function toLocal(g: LayerGeometry, p: Point): Point {
  return rotatePoint({ x: p.x - g.cx, y: p.y - g.cy }, -g.rotation);
}

export function hitTest(g: LayerGeometry, p: Point, pad = 0): boolean {
  const l = toLocal(g, p);
  return l.x >= g.vis.x0 - pad && l.x <= g.vis.x1 + pad && l.y >= g.vis.y0 - pad && l.y <= g.vis.y1 + pad;
}

/**
 * Column-major 3x3 matrix mapping unit-quad coordinates (0..1) of the visible
 * rect to normalized device coords for a frame of the given size.
 */
export function quadToClipMatrix(g: LayerGeometry, frame: Size): Float32Array {
  const r = (g.rotation * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const vw = g.vis.x1 - g.vis.x0;
  const vh = g.vis.y1 - g.vis.y0;
  // unit (u,v) -> local: (x0 + u*vw, y0 + v*vh)
  // local -> rotated + center -> frame px -> ndc: ndcX = px/W*2-1, ndcY = 1 - py/H*2
  const sx = 2 / frame.w;
  const sy = -2 / frame.h;
  // frame px = R * local + c
  // a = d(px)/du etc.
  const a = cos * vw;
  const b = sin * vw;
  const c2 = -sin * vh;
  const d = cos * vh;
  const ex = cos * g.vis.x0 - sin * g.vis.y0 + g.cx;
  const ey = sin * g.vis.x0 + cos * g.vis.y0 + g.cy;
  return new Float32Array([a * sx, b * sy, 0, c2 * sx, d * sy, 0, ex * sx - 1, ey * sy + 1, 1]);
}
