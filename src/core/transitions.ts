/**
 * Transition registry. A transition lives on the outgoing clip
 * (`clip.transitionOut`) and is rendered over a window centered on the cut
 * between it and the adjacent following clip on the same track.
 */

export interface TransitionDef {
  type: string;
  name: string;
  /** Short description for tooltips. */
  description: string;
}

export const TRANSITIONS: TransitionDef[] = [
  { type: 'crossfade', name: 'Cross Dissolve', description: 'Blend smoothly between clips.' },
  { type: 'dipBlack', name: 'Dip to Black', description: 'Fade out to black, then in.' },
  { type: 'dipWhite', name: 'Dip to White', description: 'Flash through white.' },
  { type: 'wipeLeft', name: 'Wipe Left', description: 'A soft edge sweeps from right to left.' },
  { type: 'wipeRight', name: 'Wipe Right', description: 'A soft edge sweeps from left to right.' },
  { type: 'wipeUp', name: 'Wipe Up', description: 'A soft edge sweeps upward.' },
  { type: 'wipeDown', name: 'Wipe Down', description: 'A soft edge sweeps downward.' },
  { type: 'slideLeft', name: 'Push Left', description: 'Next clip pushes the current one left.' },
  { type: 'slideRight', name: 'Push Right', description: 'Next clip pushes the current one right.' },
  { type: 'slideUp', name: 'Push Up', description: 'Next clip pushes the current one up.' },
  { type: 'slideDown', name: 'Push Down', description: 'Next clip pushes the current one down.' },
  { type: 'zoom', name: 'Zoom', description: 'Zoom through into the next clip.' },
  { type: 'iris', name: 'Circle Reveal', description: 'Expanding circle reveals the next clip.' },
  { type: 'clock', name: 'Clock Wipe', description: 'Radial sweep like a clock hand.' },
  { type: 'blur', name: 'Blur Dissolve', description: 'Blur out, dissolve, blur in.' },
  { type: 'pixelize', name: 'Pixelize', description: 'Pixelate out and back in.' },
  { type: 'glitch', name: 'Glitch', description: 'Digital glitch with RGB displacement.' },
  { type: 'spin', name: 'Spin', description: 'Rotate and zoom into the next clip.' },
];

export const TRANSITION_MAP: Record<string, TransitionDef> = Object.fromEntries(
  TRANSITIONS.map((t) => [t.type, t]),
);

export const DEFAULT_TRANSITION_DURATION = 0.8;
