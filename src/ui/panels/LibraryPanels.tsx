import { useMemo, useState } from 'react';
import { Circle, Layers, Minus, MoveRight, Search, Square, Star, Triangle } from 'lucide-react';
import { EFFECTS, FILTER_PRESETS, type EffectCategory } from '@/core/effects';
import { TEXT_PRESETS } from '@/core/textPresets';
import { TRANSITIONS } from '@/core/transitions';
import type { ShapeKind } from '@/core/types';
import { cssFontFamily, ensureFont } from '@/engine/fonts';
import * as A from '@/state/actions';
import { useEditor } from '@/state/store';
import { endDrag, startDrag } from '../dnd';
import { PanelHead } from './LeftDock';

/* --------------------------------- Text -------------------------------- */

export function TextPanel() {
  // Make sure preview fonts are available for the preset cards.
  useMemo(() => TEXT_PRESETS.forEach((p) => void ensureFont(p.style.fontFamily ?? 'Inter', p.style.fontWeight ?? 700, !!p.style.italic)), []);
  return (
    <>
      <PanelHead title="Text" />
      <div className="panel-body">
        <p className="panel-hint">Click to add at the playhead, or drag onto the timeline.</p>
        <div className="preset-grid">
          {TEXT_PRESETS.map((p) => (
            <button
              key={p.id}
              className="text-preset"
              draggable
              onDragStart={(e) => startDrag(e, { kind: 'text', preset: p.id })}
              onDragEnd={endDrag}
              onClick={() => A.addTextPreset(p.id)}
              aria-label={`Add ${p.name} text`}
            >
              <span className="text-preset-stage">
              <span
                className="text-preset-sample"
                style={{
                  fontFamily: cssFontFamily(p.style.fontFamily ?? 'Inter'),
                  fontWeight: p.style.fontWeight,
                  fontStyle: p.style.italic ? 'italic' : 'normal',
                  color: p.style.color && p.style.color !== '#00000000' ? p.style.color : '#fff',
                  textTransform: p.style.uppercase ? 'uppercase' : 'none',
                  WebkitTextStroke: p.style.strokeWidth ? `${Math.min(1.5, p.style.strokeWidth / 4)}px ${p.style.strokeColor}` : undefined,
                  background: p.style.backgroundColor ?? undefined,
                  padding: p.style.backgroundColor ? '1px 6px' : undefined,
                  borderRadius: p.style.backgroundColor ? 3 : undefined,
                  letterSpacing: p.style.letterSpacing ? `${p.style.letterSpacing}em` : undefined,
                  textShadow: p.style.shadowBlur ? `0 0 ${Math.min(10, p.style.shadowBlur / 3)}px ${p.style.shadowColor}` : undefined,
                }}
              >
                {p.text.split('\n')[0].slice(0, 22)}
              </span>
              </span>
              <span className="text-preset-name">{p.name}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* ------------------------------- Elements ------------------------------ */

const SHAPES: { kind: ShapeKind; label: string; icon: React.ReactNode }[] = [
  { kind: 'rectangle', label: 'Rectangle', icon: <Square size={22} /> },
  { kind: 'ellipse', label: 'Ellipse', icon: <Circle size={22} /> },
  { kind: 'triangle', label: 'Triangle', icon: <Triangle size={22} /> },
  { kind: 'star', label: 'Star', icon: <Star size={22} /> },
  { kind: 'line', label: 'Line', icon: <Minus size={22} /> },
  { kind: 'arrow', label: 'Arrow', icon: <MoveRight size={22} /> },
];

const BACKGROUNDS: { label: string; fill: string; fill2: string | null }[] = [
  { label: 'Black', fill: '#000000', fill2: null },
  { label: 'White', fill: '#ffffff', fill2: null },
  { label: 'Charcoal', fill: '#1f2329', fill2: null },
  { label: 'Cream', fill: '#f4ecd8', fill2: null },
  { label: 'Blue', fill: '#2f6bff', fill2: null },
  { label: 'Coral', fill: '#ff6b5b', fill2: null },
  { label: 'Sunset', fill: '#ff7e5f', fill2: '#feb47b' },
  { label: 'Ocean', fill: '#2193b0', fill2: '#6dd5ed' },
  { label: 'Purple', fill: '#7f00ff', fill2: '#e100ff' },
  { label: 'Forest', fill: '#134e5e', fill2: '#71b280' },
  { label: 'Night', fill: '#0f2027', fill2: '#2c5364' },
  { label: 'Peach', fill: '#ffecd2', fill2: '#fcb69f' },
];

export function ElementsPanel() {
  return (
    <>
      <PanelHead title="Elements" />
      <div className="panel-body">
        <h3 className="panel-subhead">Shapes</h3>
        <div className="tile-grid">
          {SHAPES.map((s) => (
            <button
              key={s.kind}
              className="tile"
              draggable
              onDragStart={(e) => startDrag(e, { kind: 'shape', shape: s.kind })}
              onDragEnd={endDrag}
              onClick={() => A.addShape(s.kind)}
              aria-label={`Add ${s.label}`}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <h3 className="panel-subhead">Backgrounds</h3>
        <div className="swatch-grid">
          {BACKGROUNDS.map((b) => (
            <button
              key={b.label}
              className="swatch"
              style={{ background: b.fill2 ? `linear-gradient(135deg, ${b.fill}, ${b.fill2})` : b.fill }}
              draggable
              onDragStart={(e) => startDrag(e, { kind: 'shape', shape: 'rectangle', fullFrame: true, fill: b.fill, fill2: b.fill2 })}
              onDragEnd={endDrag}
              onClick={() => A.addShape('rectangle', { fullFrame: true, fill: b.fill, fill2: b.fill2 })}
              aria-label={`Add ${b.label} background`}
              data-tip={`${b.label} background`}
            />
          ))}
        </div>
        <h3 className="panel-subhead">Layers</h3>
        <button className="tile wide" draggable onDragStart={(e) => startDrag(e, { kind: 'adjustment' })} onDragEnd={endDrag} onClick={() => A.addAdjustmentLayer()}>
          <Layers size={20} />
          <span>
            <strong>Adjustment layer</strong>
            <br />
            <span className="subtle">Apply color and effects to everything below it</span>
          </span>
        </button>
      </div>
    </>
  );
}

/* ----------------------------- Transitions ----------------------------- */

export function TransitionsPanel() {
  const selection = useEditor((s) => s.selection);
  return (
    <>
      <PanelHead title="Transitions" />
      <div className="panel-body">
        <p className="panel-hint">Drag onto a cut between two clips, or select a clip and click to add a transition at its end.</p>
        <div className="tile-grid">
          {TRANSITIONS.map((t) => (
            <button
              key={t.type}
              className="tile transition-tile"
              draggable
              onDragStart={(e) => startDrag(e, { kind: 'transition', type: t.type })}
              onDragEnd={endDrag}
              onClick={() => A.addTransitionToSelection(t.type)}
              disabled={false}
              data-tip={t.description}
              aria-label={`${t.name}: ${t.description}${selection.length ? '' : ' (select a clip first)'}`}
            >
              <span className={`tr-demo tr-${t.type}`} aria-hidden="true">
                <span className="a" />
                <span className="b" />
              </span>
              <span>{t.name}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* -------------------------------- Effects ------------------------------ */

export function EffectsPanel() {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const m = new Map<EffectCategory, typeof EFFECTS>();
    for (const e of EFFECTS) {
      if (q && !`${e.name} ${e.description}`.toLowerCase().includes(q.toLowerCase())) continue;
      const arr = m.get(e.category) ?? [];
      arr.push(e);
      m.set(e.category, arr);
    }
    return [...m.entries()];
  }, [q]);
  return (
    <>
      <PanelHead title="Effects" />
      <div className="panel-body">
        <div className="search" style={{ marginBottom: 8 }}>
          <Search size={14} />
          <input className="input" placeholder="Search effects" aria-label="Search effects" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <p className="panel-hint">Select clips and click an effect, or drag it onto a clip.</p>
        {groups.map(([cat, list]) => (
          <div key={cat}>
            <h3 className="panel-subhead">{cat}</h3>
            <div className="list">
              {list.map((e) => (
                <button key={e.type} className="list-item" draggable onDragStart={(ev) => startDrag(ev, { kind: 'effect', type: e.type })} onDragEnd={endDrag} onClick={() => A.applyEffectToSelection(e.type)}>
                  <span className={`fx-dot fx-${e.category.split(' ')[0].toLowerCase()}`} aria-hidden="true" />
                  <span className="grow">
                    <span className="list-title">{e.name}</span>
                    <span className="list-sub">{e.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* -------------------------------- Filters ------------------------------ */

export function FiltersPanel() {
  return (
    <>
      <PanelHead title="Filters" />
      <div className="panel-body">
        <p className="panel-hint">One-click looks for the selected clips. Fine-tune them in the inspector’s Color section.</p>
        <div className="filter-grid">
          {FILTER_PRESETS.map((f) => (
            <button key={f.id} className="filter-tile" draggable onDragStart={(e) => startDrag(e, { kind: 'filter', id: f.id })} onDragEnd={endDrag} onClick={() => A.applyFilterPreset(f.id)}>
              <span className="filter-swatch" style={{ background: f.swatch }} />
              <span>{f.name}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
