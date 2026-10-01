import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * One global tooltip driven by `data-tip` (and optional `data-kbd`)
 * attributes, so any element can have a tooltip without wrapper components.
 * Shown on hover after a short delay and on keyboard focus.
 */

interface TipState {
  text: string;
  kbd?: string;
  x: number;
  y: number;
  below: boolean;
}

function findTipTarget(el: EventTarget | null): HTMLElement | null {
  let n = el as HTMLElement | null;
  while (n && n !== document.body) {
    if (n.dataset?.tip) return n;
    n = n.parentElement;
  }
  return null;
}

export function TooltipLayer() {
  const [tip, setTip] = useState<TipState | null>(null);

  useEffect(() => {
    let timer: number | null = null;
    let current: HTMLElement | null = null;
    const show = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const below = r.top < 48;
      setTip({ text: el.dataset.tip!, kbd: el.dataset.kbd, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
    };
    const hide = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      current = null;
      setTip(null);
    };
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = findTipTarget(e.target);
      if (el === current) return;
      hide();
      if (!el) return;
      current = el;
      timer = window.setTimeout(() => current === el && document.contains(el) && show(el), 450);
    };
    const onFocus = (e: FocusEvent) => {
      const el = findTipTarget(e.target);
      if (el && (e.target as HTMLElement).matches(':focus-visible')) {
        current = el;
        show(el);
      }
    };
    window.addEventListener('pointerover', onOver);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('focusin', onFocus);
    window.addEventListener('focusout', hide);
    window.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('keydown', hide);
    return () => {
      window.removeEventListener('pointerover', onOver);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('focusin', onFocus);
      window.removeEventListener('focusout', hide);
      window.removeEventListener('wheel', hide);
      window.removeEventListener('keydown', hide);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div
      className="tooltip"
      role="tooltip"
      style={{
        left: Math.min(Math.max(8, tip.x), window.innerWidth - 8),
        top: tip.y,
        transform: `translate(-50%, ${tip.below ? '0' : '-100%'})`,
      }}
    >
      <span>{tip.text}</span>
      {tip.kbd && <span className="kbd">{tip.kbd}</span>}
    </div>,
    document.body,
  );
}
