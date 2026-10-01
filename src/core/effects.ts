import { uid } from './ids';
import type { ColorAdjust, Effect } from './types';

/**
 * Effect registry: the single source of truth for which effects exist and what
 * parameters they take. The UI builds its controls from these definitions and
 * the renderer (engine/effectsGL.ts) implements each `type` as shader passes.
 */

export type EffectParamDef =
  | {
      key: string;
      label: string;
      kind: 'number';
      min: number;
      max: number;
      step: number;
      default: number;
      unit?: string;
      /** Can be keyframed. */
      animatable?: boolean;
    }
  | { key: string; label: string; kind: 'color'; default: string }
  | { key: string; label: string; kind: 'boolean'; default: boolean }
  | { key: string; label: string; kind: 'select'; default: string; options: { value: string; label: string }[] };

export type EffectCategory = 'Blur & Sharpen' | 'Stylize' | 'Color' | 'Distort' | 'Keying';

export interface EffectDef {
  type: string;
  name: string;
  category: EffectCategory;
  description: string;
  params: EffectParamDef[];
}

const n = (
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  def: number,
  unit?: string,
): EffectParamDef => ({ key, label, kind: 'number', min, max, step, default: def, unit, animatable: true });

export const EFFECTS: EffectDef[] = [
  {
    type: 'blur',
    name: 'Gaussian Blur',
    category: 'Blur & Sharpen',
    description: 'Soft, even blur. Animate it for focus pulls.',
    params: [n('amount', 'Amount', 0, 100, 1, 20)],
  },
  {
    type: 'directionalBlur',
    name: 'Motion Blur',
    category: 'Blur & Sharpen',
    description: 'Blur along one direction to suggest movement.',
    params: [n('amount', 'Amount', 0, 100, 1, 25), n('angle', 'Angle', -180, 180, 1, 0, '°')],
  },
  {
    type: 'zoomBlur',
    name: 'Zoom Blur',
    category: 'Blur & Sharpen',
    description: 'Radial blur from the center.',
    params: [n('amount', 'Amount', 0, 100, 1, 30)],
  },
  {
    type: 'sharpen',
    name: 'Sharpen',
    category: 'Blur & Sharpen',
    description: 'Unsharp-mask sharpening for crisper detail.',
    params: [n('amount', 'Amount', 0, 200, 1, 60, '%')],
  },
  {
    type: 'vignette',
    name: 'Vignette',
    category: 'Stylize',
    description: 'Darken or lighten the edges of the frame.',
    params: [
      n('amount', 'Amount', -100, 100, 1, 50),
      n('size', 'Size', 0, 100, 1, 50),
      n('softness', 'Softness', 0, 100, 1, 60),
    ],
  },
  {
    type: 'grain',
    name: 'Film Grain',
    category: 'Stylize',
    description: 'Animated film-like noise.',
    params: [n('amount', 'Amount', 0, 100, 1, 25), n('size', 'Size', 1, 4, 0.1, 1.5)],
  },
  {
    type: 'glow',
    name: 'Glow',
    category: 'Stylize',
    description: 'Bloom around bright areas.',
    params: [
      n('strength', 'Strength', 0, 200, 1, 60, '%'),
      n('radius', 'Radius', 0, 100, 1, 30),
      n('threshold', 'Threshold', 0, 100, 1, 60, '%'),
    ],
  },
  {
    type: 'rgbSplit',
    name: 'RGB Split',
    category: 'Stylize',
    description: 'Chromatic aberration / glitch color fringing.',
    params: [n('amount', 'Amount', 0, 100, 1, 20), n('angle', 'Angle', -180, 180, 1, 0, '°')],
  },
  {
    type: 'pixelate',
    name: 'Pixelate',
    category: 'Stylize',
    description: 'Mosaic blocks. Useful for censoring.',
    params: [n('size', 'Block size', 1, 200, 1, 24, 'px')],
  },
  {
    type: 'posterize',
    name: 'Posterize',
    category: 'Stylize',
    description: 'Reduce the number of color levels.',
    params: [n('levels', 'Levels', 2, 32, 1, 6)],
  },
  {
    type: 'vhs',
    name: 'VHS',
    category: 'Stylize',
    description: 'Retro tape look: scanlines, color bleed, and jitter.',
    params: [n('amount', 'Amount', 0, 100, 1, 60)],
  },
  {
    type: 'border',
    name: 'Border',
    category: 'Stylize',
    description: 'Outline around the clip edges.',
    params: [
      n('width', 'Width', 0, 100, 1, 12, 'px'),
      { key: 'color', label: 'Color', kind: 'color', default: '#ffffff' },
    ],
  },
  {
    type: 'grayscale',
    name: 'Black & White',
    category: 'Color',
    description: 'Monochrome conversion.',
    params: [n('amount', 'Amount', 0, 100, 1, 100, '%')],
  },
  {
    type: 'sepia',
    name: 'Sepia',
    category: 'Color',
    description: 'Warm, aged tone.',
    params: [n('amount', 'Amount', 0, 100, 1, 80, '%')],
  },
  {
    type: 'duotone',
    name: 'Duotone',
    category: 'Color',
    description: 'Map shadows and highlights to two colors.',
    params: [
      { key: 'dark', label: 'Shadows', kind: 'color', default: '#1b1464' },
      { key: 'light', label: 'Highlights', kind: 'color', default: '#ff6f61' },
      n('amount', 'Amount', 0, 100, 1, 100, '%'),
    ],
  },
  {
    type: 'tint',
    name: 'Color Overlay',
    category: 'Color',
    description: 'Wash the image with a color.',
    params: [{ key: 'color', label: 'Color', kind: 'color', default: '#ff8a00' }, n('amount', 'Amount', 0, 100, 1, 30, '%')],
  },
  {
    type: 'invert',
    name: 'Invert',
    category: 'Color',
    description: 'Negative image.',
    params: [n('amount', 'Amount', 0, 100, 1, 100, '%')],
  },
  {
    type: 'mirror',
    name: 'Mirror',
    category: 'Distort',
    description: 'Reflect the image.',
    params: [
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        default: 'horizontal',
        options: [
          { value: 'horizontal', label: 'Left → Right' },
          { value: 'vertical', label: 'Top → Bottom' },
          { value: 'quad', label: 'Four-way' },
        ],
      },
    ],
  },
  {
    type: 'wave',
    name: 'Wave Warp',
    category: 'Distort',
    description: 'Animated sine-wave distortion.',
    params: [n('amount', 'Amount', 0, 100, 1, 20), n('frequency', 'Frequency', 1, 40, 0.5, 8), n('speed', 'Speed', 0, 10, 0.1, 2)],
  },
  {
    type: 'chromaKey',
    name: 'Chroma Key',
    category: 'Keying',
    description: 'Remove a green or blue screen background.',
    params: [
      { key: 'keyColor', label: 'Key color', kind: 'color', default: '#00ff00' },
      n('similarity', 'Similarity', 0, 100, 1, 40, '%'),
      n('smoothness', 'Smoothness', 0, 100, 1, 10, '%'),
      n('spill', 'Spill reduction', 0, 100, 1, 50, '%'),
    ],
  },
  {
    type: 'lumaKey',
    name: 'Luma Key',
    category: 'Keying',
    description: 'Make dark (or bright) areas transparent.',
    params: [
      n('threshold', 'Threshold', 0, 100, 1, 15, '%'),
      n('softness', 'Softness', 0, 100, 1, 10, '%'),
      { key: 'invert', label: 'Key out brights', kind: 'boolean', default: false },
    ],
  },
];

export const EFFECT_MAP: Record<string, EffectDef> = Object.fromEntries(EFFECTS.map((e) => [e.type, e]));

export function createEffect(type: string): Effect {
  const def = EFFECT_MAP[type];
  if (!def) throw new Error(`Unknown effect: ${type}`);
  const params: Effect['params'] = {};
  for (const p of def.params) params[p.key] = p.default;
  return { id: uid('fx'), type, enabled: true, params };
}

export const NEUTRAL_COLOR: ColorAdjust = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  vibrance: 0,
  hue: 0,
};

export function isNeutralColor(c: ColorAdjust): boolean {
  return (
    Math.abs(c.exposure) < 1e-4 &&
    Math.abs(c.contrast) < 1e-4 &&
    Math.abs(c.saturation) < 1e-4 &&
    Math.abs(c.temperature) < 1e-4 &&
    Math.abs(c.tint) < 1e-4 &&
    Math.abs(c.highlights) < 1e-4 &&
    Math.abs(c.shadows) < 1e-4 &&
    Math.abs(c.vibrance) < 1e-4 &&
    Math.abs(c.hue) < 1e-4
  );
}

export interface ColorParamDef {
  key: keyof ColorAdjust;
  label: string;
  min: number;
  max: number;
  step: number;
}

export const COLOR_PARAMS: ColorParamDef[] = [
  { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.01 },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01 },
  { key: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.01 },
  { key: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.01 },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01 },
  { key: 'vibrance', label: 'Vibrance', min: -1, max: 1, step: 0.01 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1, step: 0.01 },
  { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01 },
  { key: 'hue', label: 'Hue', min: -180, max: 180, step: 1 },
];

/** One-click looks: a color adjustment plus optional effects. */
export interface FilterPreset {
  id: string;
  name: string;
  color: Partial<ColorAdjust>;
  effects?: { type: string; params?: Record<string, number | string | boolean> }[];
  /** CSS gradient used for the swatch in the UI. */
  swatch: string;
}

export const FILTER_PRESETS: FilterPreset[] = [
  { id: 'none', name: 'Original', color: {}, swatch: 'linear-gradient(135deg,#4a6fa5,#c9a66b)' },
  { id: 'vivid', name: 'Vivid', color: { contrast: 0.15, saturation: 0.3, vibrance: 0.25 }, swatch: 'linear-gradient(135deg,#0072ff,#ff3d00)' },
  { id: 'warm', name: 'Warm', color: { temperature: 0.35, tint: 0.05, saturation: 0.08 }, swatch: 'linear-gradient(135deg,#f6a04d,#d95d39)' },
  { id: 'cool', name: 'Cool', color: { temperature: -0.35, saturation: 0.05 }, swatch: 'linear-gradient(135deg,#4facfe,#1e3c72)' },
  { id: 'cinematic', name: 'Cinematic', color: { contrast: 0.2, saturation: -0.15, temperature: -0.1, shadows: -0.1, highlights: -0.15 }, effects: [{ type: 'vignette', params: { amount: 35, size: 60, softness: 70 } }], swatch: 'linear-gradient(135deg,#0f2027,#2c5364,#d1913c)' },
  { id: 'tealorange', name: 'Teal & Orange', color: { contrast: 0.15, temperature: 0.1, saturation: 0.15, tint: -0.1 }, swatch: 'linear-gradient(135deg,#00818a,#f08a4b)' },
  { id: 'faded', name: 'Faded', color: { contrast: -0.25, saturation: -0.25, shadows: 0.25 }, swatch: 'linear-gradient(135deg,#b8b3a8,#7d8a8c)' },
  { id: 'vintage', name: 'Vintage', color: { contrast: -0.1, saturation: -0.3, temperature: 0.25 }, effects: [{ type: 'sepia', params: { amount: 25 } }, { type: 'grain', params: { amount: 20 } }, { type: 'vignette', params: { amount: 40 } }], swatch: 'linear-gradient(135deg,#a67c52,#5e4b3c)' },
  { id: 'noir', name: 'Noir', color: { contrast: 0.35, saturation: -1, exposure: -0.1 }, effects: [{ type: 'vignette', params: { amount: 50 } }], swatch: 'linear-gradient(135deg,#000,#bbb)' },
  { id: 'mono', name: 'Mono', color: { saturation: -1 }, swatch: 'linear-gradient(135deg,#333,#ddd)' },
  { id: 'bright', name: 'Bright', color: { exposure: 0.3, shadows: 0.2, contrast: -0.05 }, swatch: 'linear-gradient(135deg,#fff6d5,#ffd36e)' },
  { id: 'moody', name: 'Moody', color: { exposure: -0.2, contrast: 0.2, saturation: -0.2, temperature: -0.15, highlights: -0.2 }, swatch: 'linear-gradient(135deg,#232526,#414345)' },
];
