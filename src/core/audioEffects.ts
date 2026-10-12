import { uid } from './ids';
import type { EffectParamDef } from './effects';
import type { Effect } from './types';

/**
 * Audio effects a clip's sound runs through (before its volume, pan and
 * fades), implemented in engine/audioDsp.ts and applied by the shared mixer,
 * so the preview and the export sound the same.
 */

export interface AudioEffectDef {
  type: string;
  name: string;
  description: string;
  params: EffectParamDef[];
}

const n = (key: string, label: string, min: number, max: number, step: number, def: number, unit?: string): EffectParamDef => ({
  key,
  label,
  kind: 'number',
  min,
  max,
  step,
  default: def,
  unit,
});

export const AUDIO_EFFECTS: AudioEffectDef[] = [
  {
    type: 'eq',
    name: 'Equalizer',
    description: 'Shape the tone: bass, middle and treble.',
    params: [n('low', 'Bass (120 Hz)', -15, 15, 0.5, 0, 'dB'), n('mid', 'Middle', -15, 15, 0.5, 0, 'dB'), n('midFrequency', 'Middle at', 200, 5000, 10, 1000, 'Hz'), n('high', 'Treble (6 kHz)', -15, 15, 0.5, 0, 'dB')],
  },
  {
    type: 'highpass',
    name: 'Low cut',
    description: 'Remove rumble, wind and handling noise below a frequency.',
    params: [n('frequency', 'Cut below', 20, 500, 1, 80, 'Hz')],
  },
  {
    type: 'lowpass',
    name: 'High cut',
    description: 'Remove hiss and harshness above a frequency (or make a muffled, “next room” sound).',
    params: [n('frequency', 'Cut above', 500, 20000, 10, 8000, 'Hz')],
  },
  {
    type: 'compressor',
    name: 'Compressor',
    description: 'Even out loud and quiet parts so speech stays clear and steady.',
    params: [
      n('threshold', 'Threshold', -60, 0, 0.5, -24, 'dB'),
      n('ratio', 'Ratio', 1, 20, 0.1, 4, ':1'),
      n('attack', 'Attack', 0.1, 100, 0.1, 10, 'ms'),
      n('release', 'Release', 10, 1000, 1, 150, 'ms'),
      n('makeup', 'Make-up gain', 0, 24, 0.5, 6, 'dB'),
    ],
  },
];

export const AUDIO_EFFECT_MAP: Record<string, AudioEffectDef> = Object.fromEntries(AUDIO_EFFECTS.map((e) => [e.type, e]));

export function createAudioEffect(type: string): Effect {
  const def = AUDIO_EFFECT_MAP[type];
  if (!def) throw new Error(`Unknown audio effect: ${type}`);
  const params: Effect['params'] = {};
  for (const p of def.params) params[p.key] = p.default;
  return { id: uid('afx'), type, enabled: true, params };
}

/** One-click starting points for common jobs. */
export const AUDIO_PRESETS: { id: string; name: string; description: string; effects: { type: string; params?: Effect['params'] }[] }[] = [
  {
    id: 'voice',
    name: 'Clear voice',
    description: 'Low cut, a little presence and gentle compression for speech.',
    effects: [
      { type: 'highpass', params: { frequency: 90 } },
      { type: 'eq', params: { low: -2, mid: 2, midFrequency: 3000, high: 1.5 } },
      { type: 'compressor', params: { threshold: -22, ratio: 3, attack: 8, release: 120, makeup: 5 } },
    ],
  },
  {
    id: 'phone',
    name: 'Telephone',
    description: 'Thin, band-limited sound of a phone call.',
    effects: [
      { type: 'highpass', params: { frequency: 400 } },
      { type: 'lowpass', params: { frequency: 3200 } },
      { type: 'eq', params: { low: 0, mid: 6, midFrequency: 1500, high: 0 } },
    ],
  },
  {
    id: 'muffled',
    name: 'Next room',
    description: 'Muffled, as if heard through a wall.',
    effects: [{ type: 'lowpass', params: { frequency: 700 } }],
  },
];

export function presetEffects(id: string): Effect[] {
  const preset = AUDIO_PRESETS.find((p) => p.id === id);
  if (!preset) return [];
  return preset.effects.map((e) => {
    const fx = createAudioEffect(e.type);
    Object.assign(fx.params, e.params);
    return fx;
  });
}
