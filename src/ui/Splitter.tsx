import { useRef, useState } from 'react';

/** Draggable (and keyboard-adjustable) divider between panes. */
export function Splitter({
  dir,
  value,
  min,
  max,
  onChange,
  invert,
  label,
}: {
  dir: 'v' | 'h';
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  invert?: boolean;
  label: string;
}) {
  const [drag, setDrag] = useState(false);
  const start = useRef({ pos: 0, value: 0 });
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div
      className={`splitter-${dir}${drag ? ' dragging' : ''}`}
      role="separator"
      aria-orientation={dir === 'v' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        start.current = { pos: dir === 'v' ? e.clientX : e.clientY, value };
        setDrag(true);
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const d = (dir === 'v' ? e.clientX : e.clientY) - start.current.pos;
        onChange(clamp(start.current.value + (invert ? -d : d)));
      }}
      onPointerUp={() => setDrag(false)}
      onPointerCancel={() => setDrag(false)}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 40 : 10;
        const dec = dir === 'v' ? 'ArrowLeft' : 'ArrowUp';
        const inc = dir === 'v' ? 'ArrowRight' : 'ArrowDown';
        if (e.key === dec || e.key === inc) {
          e.preventDefault();
          e.stopPropagation();
          const sign = (e.key === inc ? 1 : -1) * (invert ? -1 : 1);
          onChange(clamp(value + sign * step));
        }
      }}
    />
  );
}
