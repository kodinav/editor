import type { Easing } from './types';

export const EASINGS: { id: Easing; label: string }[] = [
  { id: 'linear', label: 'Linear' },
  { id: 'easeIn', label: 'Ease in' },
  { id: 'easeOut', label: 'Ease out' },
  { id: 'easeInOut', label: 'Ease in & out' },
  { id: 'hold', label: 'Hold' },
  { id: 'backOut', label: 'Overshoot' },
  { id: 'elasticOut', label: 'Elastic' },
  { id: 'bounceOut', label: 'Bounce' },
];

/** Map normalized progress (0..1) through an easing curve. */
export function ease(kind: Easing, p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  switch (kind) {
    case 'linear':
      return p;
    case 'easeIn':
      return p * p * p;
    case 'easeOut':
      return 1 - Math.pow(1 - p, 3);
    case 'easeInOut':
      return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    case 'hold':
      return 0;
    case 'backOut': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
    }
    case 'elasticOut': {
      const c4 = (2 * Math.PI) / 3;
      return Math.pow(2, -10 * p) * Math.sin((p * 10 - 0.75) * c4) + 1;
    }
    case 'bounceOut': {
      const n1 = 7.5625;
      const d1 = 2.75;
      if (p < 1 / d1) return n1 * p * p;
      if (p < 2 / d1) return n1 * (p -= 1.5 / d1) * p + 0.75;
      if (p < 2.5 / d1) return n1 * (p -= 2.25 / d1) * p + 0.9375;
      return n1 * (p -= 2.625 / d1) * p + 0.984375;
    }
  }
}
