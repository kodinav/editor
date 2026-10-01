import type { ShapeClip } from '@/core/types';

/** Rasterize vector shapes with Canvas 2D at a given render scale. */

export interface ShapeRender {
  canvas: OffscreenCanvas;
  w: number;
  h: number;
}

function path(ctx: OffscreenCanvasRenderingContext2D, c: ShapeClip, x: number, y: number, w: number, h: number, s: number) {
  ctx.beginPath();
  switch (c.shape) {
    case 'rectangle': {
      const r = Math.max(0, Math.min(c.radius * s, w / 2, h / 2));
      ctx.roundRect(x, y, w, h, r);
      break;
    }
    case 'ellipse':
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case 'triangle':
      ctx.moveTo(x + w / 2, y);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.closePath();
      break;
    case 'star': {
      const cx = x + w / 2;
      const cy = y + h / 2;
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? 1 : 0.42;
        const px = cx + Math.cos(a) * (w / 2) * rr;
        const py = cy + Math.sin(a) * (h / 2) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case 'line':
      ctx.roundRect(x, y, w, h, Math.min(h / 2, w / 2));
      break;
    case 'arrow': {
      const shaft = h * 0.36;
      const head = Math.min(w * 0.4, h * 1.1);
      ctx.moveTo(x, y + h / 2 - shaft / 2);
      ctx.lineTo(x + w - head, y + h / 2 - shaft / 2);
      ctx.lineTo(x + w - head, y);
      ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w - head, y + h);
      ctx.lineTo(x + w - head, y + h / 2 + shaft / 2);
      ctx.lineTo(x, y + h / 2 + shaft / 2);
      ctx.closePath();
      break;
    }
  }
}

export function renderShape(c: ShapeClip, scale: number): ShapeRender {
  const s = Math.max(0.05, scale);
  const stroke = c.strokeWidth * s;
  const pad = Math.ceil(stroke / 2 + 2);
  const w = Math.max(1, c.width * s);
  const h = Math.max(1, c.height * s);
  const W = Math.min(8192, Math.ceil(w + pad * 2));
  const H = Math.min(8192, Math.ceil(h + pad * 2));
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d')!;
  path(ctx, c, pad, pad, w, h, s);
  if (c.fill2) {
    const a = ((c.gradientAngle - 90) * Math.PI) / 180;
    const cx = pad + w / 2;
    const cy = pad + h / 2;
    const r = Math.hypot(w, h) / 2;
    const g = ctx.createLinearGradient(cx - Math.cos(a) * r, cy - Math.sin(a) * r, cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    g.addColorStop(0, c.fill);
    g.addColorStop(1, c.fill2);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = c.fill;
  }
  ctx.fill();
  if (stroke > 0) {
    ctx.lineWidth = stroke;
    ctx.strokeStyle = c.strokeColor;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  return { canvas, w: W / s, h: H / s };
}
