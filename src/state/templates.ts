import { createEffect } from '@/core/effects';
import { addTrack } from '@/core/ops';
import { createShapeClip, createTextClip } from '@/core/project';
import type { Project, TextStyle } from '@/core/types';
import { editor } from './store';
import { player } from '@/playback/player';

/**
 * Starter templates built only from ordinary project primitives (shapes,
 * text, animation presets, transitions), so everything stays editable.
 */

export interface Template {
  id: string;
  name: string;
  description: string;
  build(d: Project): void;
}

function tracks(d: Project) {
  let vids = d.tracks.filter((t) => t.kind === 'video');
  while (vids.length < 3) {
    addTrack(d, 'video');
    vids = d.tracks.filter((t) => t.kind === 'video');
  }
  // Top-most first in the array; return bottom, middle, top.
  return { bottom: vids[vids.length - 1].id, middle: vids[vids.length - 2].id, top: vids[vids.length - 3].id };
}

function k(d: Project) {
  return Math.min(d.settings.width, d.settings.height) / 1080;
}

function text(d: Project, trackId: string, start: number, duration: number, body: string, style: Partial<TextStyle>, y = 0) {
  const s = k(d);
  const c = createTextClip({ trackId, start, duration }, body, { ...style, fontSize: Math.round((style.fontSize ?? 96) * s) });
  c.transform.y = y * d.settings.height;
  d.clips[c.id] = c;
  return c;
}

function background(d: Project, trackId: string, start: number, duration: number, fill: string, fill2: string | null, angle = 135) {
  const c = createShapeClip({ trackId, start, duration }, 'rectangle', { width: d.settings.width, height: d.settings.height, fill, fill2, gradientAngle: angle, radius: 0 });
  c.name = 'Background';
  d.clips[c.id] = c;
  return c;
}

export const TEMPLATES: Template[] = [
  {
    id: 'intro',
    name: 'Bold intro',
    description: 'Gradient background, punchy title and subtitle',
    build(d) {
      const t = tracks(d);
      const bg = background(d, t.bottom, 0, 5, '#5b2dff', '#ff4f8b');
      bg.effects.push({ ...createEffect('grain'), params: { amount: 12, size: 1.5 } });
      const title = text(d, t.middle, 0.3, 4.4, 'YOUR CHANNEL', { fontFamily: 'Anton', fontWeight: 400, fontSize: 170, letterSpacing: 0.04 }, -0.04);
      title.animIn = { preset: 'pop', duration: 0.5 };
      title.animOut = { preset: 'zoomIn', duration: 0.5 };
      const sub = text(d, t.top, 0.9, 3.8, 'New videos every week', { fontFamily: 'Inter', fontWeight: 500, fontSize: 56, color: '#ffe6f0' }, 0.1);
      sub.animIn = { preset: 'slideUp', duration: 0.6 };
      sub.animOut = { preset: 'fade', duration: 0.4 };
    },
  },
  {
    id: 'quote',
    name: 'Quote card',
    description: 'Elegant serif quote with a slow fade',
    build(d) {
      const t = tracks(d);
      background(d, t.bottom, 0, 6, '#14151a', '#2a2f3a', 160);
      const q = text(d, t.middle, 0.4, 5.2, '“The details are not the details. They make the design.”', { fontFamily: 'Playfair Display', fontWeight: 400, italic: true, fontSize: 78, maxWidth: 0.72, lineHeight: 1.3 }, -0.05);
      q.animIn = { preset: 'blur', duration: 1 };
      q.animOut = { preset: 'fade', duration: 0.8 };
      const a = text(d, t.top, 1.4, 4.2, '— Charles Eames', { fontFamily: 'Inter', fontWeight: 500, fontSize: 40, color: '#b9c0cc', letterSpacing: 0.08 }, 0.2);
      a.animIn = { preset: 'fade', duration: 0.8 };
      a.animOut = { preset: 'fade', duration: 0.8 };
    },
  },
  {
    id: 'countdown',
    name: 'Countdown',
    description: '3 · 2 · 1 with color changes and transitions',
    build(d) {
      const t = tracks(d);
      const colors: [string, string][] = [
        ['#ff6b4a', '#ffb347'],
        ['#2ec5ff', '#2f6bff'],
        ['#36d399', '#0f9b6c'],
      ];
      const bgs = colors.map(([a, b], i) => background(d, t.bottom, i, 1, a, b));
      bgs.forEach((bg, i) => {
        if (i < bgs.length - 1) bg.transitionOut = { type: 'slideLeft', duration: 0.3 };
      });
      ['3', '2', '1'].forEach((n, i) => {
        const c = text(d, t.middle, i, 1, n, { fontFamily: 'Archivo Black', fontWeight: 400, fontSize: 420, shadowColor: '#00000066', shadowBlur: 30, shadowY: 12 });
        c.animIn = { preset: 'pop', duration: 0.35 };
      });
      const go = text(d, t.middle, 3, 1.5, 'GO!', { fontFamily: 'Bangers', fontWeight: 400, fontSize: 300, color: '#ffe14d', strokeColor: '#1a1a1a', strokeWidth: 10 });
      go.animIn = { preset: 'spin', duration: 0.4 };
      background(d, t.bottom, 3, 1.5, '#111318', null);
    },
  },
];

export function applyTemplate(id: string) {
  const tpl = TEMPLATES.find((x) => x.id === id);
  if (!tpl) return;
  editor().commit(`Template: ${tpl.name}`, (d) => tpl.build(d));
  editor().select([]);
  player.seek(1.2);
}
