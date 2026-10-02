import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { evalMath } from '@/core/math';

/**
 * Inspector form controls. Continuous edits report `onBegin` / `onChange` /
 * `onEnd` so callers can fold a whole drag into one undo step.
 */

export interface ContinuousProps {
  onBegin?: () => void;
  onEnd?: () => void;
}

function fmt(v: number, step: number): string {
  if (!isFinite(v)) return '';
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  return v.toFixed(decimals);
}

export function NumberField({
  label,
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  unit,
  scale = 1,
  ariaLabel,
  onBegin,
  onEnd,
  disabled,
}: {
  label?: ReactNode;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  /** Display multiplier (e.g. 100 to show 0..1 as percent). */
  scale?: number;
  ariaLabel?: string;
  disabled?: boolean;
} & ContinuousProps) {
  const shown = value * scale;
  const [text, setText] = useState(fmt(shown, step));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(fmt(shown, step));
  }, [shown, step, editing]);

  const clampV = (v: number) => Math.min(max, Math.max(min, v));
  // The handlers in effect when editing started: if the selection changes before the field
  // loses focus (clicking another clip), the typed value still goes to the original target.
  const target = useRef({ onChange, onBegin, onEnd, original: '' });
  const apply = (value: string): boolean => {
    const t = target.current;
    if (value === t.original) return true; // just focused and left: nothing to write
    // Allow simple math like "1920/2" or "45+10".
    const n = evalMath(value);
    if (!isFinite(n)) return false;
    t.onBegin?.();
    t.onChange(clampV(n / scale));
    t.onEnd?.();
    return true;
  };
  const commitText = () => {
    setEditing(false);
    if (!apply(text)) setText(fmt(shown, step));
  };
  // Selecting another clip can unmount the field before it blurs: keep what was typed.
  const pending = useRef<string | null>(null);
  pending.current = editing ? text : null;
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(
    () => () => {
      if (pending.current !== null) applyRef.current(pending.current);
    },
    [],
  );

  const onScrubDown = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startV = shown;
    let moved = false;
    onBegin?.();
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      const v = startV + Math.round(dx) * step * mult;
      onChange(clampV(Math.round(v / step) * step / scale));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onEnd?.();
      if (!moved) (el.nextElementSibling as HTMLInputElement | null)?.focus();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  return (
    <div className="numfield" style={disabled ? { opacity: 0.5 } : undefined}>
      {label !== undefined && (
        <span className="scrub" onPointerDown={onScrubDown} aria-hidden="true" title="Drag to adjust">
          {label}
        </span>
      )}
      <input
        aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        inputMode="decimal"
        value={text}
        disabled={disabled}
        onFocus={(e) => {
          target.current = { onChange, onBegin, onEnd, original: text };
          setEditing(true);
          e.currentTarget.select();
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          else if (e.key === 'Escape') {
            setText(fmt(shown, step));
            setEditing(false);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
            const v = clampV((shown + (e.key === 'ArrowUp' ? 1 : -1) * step * mult) / scale);
            onBegin?.();
            onChange(v);
            onEnd?.();
            setText(fmt(v * scale, step));
          }
          e.stopPropagation();
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 0.01,
  ariaLabel,
  onBegin,
  onEnd,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
  disabled?: boolean;
} & ContinuousProps) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className="slider"
      aria-label={ariaLabel}
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      style={{ ['--fill' as string]: `${Math.max(0, Math.min(100, fill))}%` }}
      onPointerDown={() => onBegin?.()}
      onPointerUp={() => onEnd?.()}
      onPointerCancel={() => onEnd?.()}
      onLostPointerCapture={() => onEnd?.()}
      onBlur={() => onEnd?.()}
      onKeyDown={(e) => {
        // Only the slider's own keys stay here; Space, Undo and the rest reach the shortcuts.
        if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) {
          onBegin?.();
          e.stopPropagation();
        }
      }}
      onKeyUp={() => onEnd?.()}
      onChange={(e) => onChange(Number(e.target.value))}
      onDoubleClick={(e) => e.preventDefault()}
    />
  );
}

/** Label + slider + numeric field on one row, with optional trailing control (keyframe toggle). */
export function SliderRow({
  label,
  value,
  onChange,
  min,
  max,
  step = 0.01,
  unit,
  scale = 1,
  trailing,
  onBegin,
  onEnd,
  defaultValue,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  scale?: number;
  trailing?: ReactNode;
  defaultValue?: number;
  disabled?: boolean;
} & ContinuousProps) {
  return (
    <div className="prop-row">
      <span
        className="prop-label"
        onDoubleClick={() => {
          if (defaultValue === undefined) return;
          onBegin?.();
          onChange(defaultValue);
          onEnd?.();
        }}
        title={defaultValue !== undefined ? 'Double-click to reset' : undefined}
      >
        {label}
      </span>
      <Slider value={value} min={min} max={max} step={step} onChange={onChange} ariaLabel={label} onBegin={onBegin} onEnd={onEnd} disabled={disabled} />
      <div style={{ width: 64, flexShrink: 0 }}>
        <NumberField value={value} onChange={onChange} min={min} max={max} step={step * scale} unit={unit} scale={scale} ariaLabel={`${label} value`} onBegin={onBegin} onEnd={onEnd} disabled={disabled} />
      </div>
      {trailing ?? <span style={{ width: 20, flexShrink: 0 }} />}
    </div>
  );
}

/** Colour picker + hex input. Picker drags arrive as a stream of changes; callers coalesce them into one undo step. */
export function ColorField({ value, onChange, ariaLabel, allowNone }: { value: string | null; onChange: (v: string | null) => void; ariaLabel: string; allowNone?: boolean } & ContinuousProps) {
  const hex = value && /^#[0-9a-f]{6}/i.test(value) ? value.slice(0, 7) : '#000000';
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  return (
    <div className="color-field">
      <input
        type="color"
        aria-label={ariaLabel}
        value={hex}
        onChange={(e) => onChange(e.target.value)}
      />
      <input
        type="text"
        aria-label={`${ariaLabel} hex`}
        value={value === null ? 'None' : text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => {
          const t = text.trim();
          if (allowNone && (t === '' || t.toLowerCase() === 'none')) onChange(null);
          else if (/^#?[0-9a-f]{6}([0-9a-f]{2})?$/i.test(t)) onChange(t.startsWith('#') ? t : '#' + t);
          else setText(value ?? '');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
      />
      {allowNone && value !== null && (
        <button className="icon-btn tiny" aria-label={`Remove ${ariaLabel}`} data-tip="Remove" onClick={() => onChange(null)}>
          ×
        </button>
      )}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: { value: T; label: ReactNode; tip?: string }[]; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          aria-pressed={value === o.value}
          data-tip={o.tip}
          // Visible text is the accessible name; the tip only names icon-only options.
          aria-label={typeof o.label === 'string' ? undefined : o.tip}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, children, defaultOpen = true, actions, id }: { title: string; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode; id?: string }) {
  const key = `section:${id ?? title}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === '1';
    } catch {
      return defaultOpen;
    }
  });
  const bodyId = useId();
  return (
    <section className="insp-section">
      <div className="insp-section-head">
        <button
          className="insp-section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            setOpen(!open);
            try {
              localStorage.setItem(key, !open ? '1' : '0');
            } catch {
              /* storage unavailable */
            }
          }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{title}</span>
        </button>
        {actions}
      </div>
      {open && (
        <div className="insp-section-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}

/** Generic row: label on the left, control on the right. */
export function Row({ label, children, trailing }: { label: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <div className="grow" style={{ display: 'flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
        {children}
      </div>
      {trailing ?? null}
    </div>
  );
}

export function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}
