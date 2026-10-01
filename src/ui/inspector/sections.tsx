import { useState } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowUp,
  CaseUpper,
  Crop,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  Italic,
  Plus,
  RotateCcw,
  Snowflake,
  Trash2,
  Unlink,
} from 'lucide-react';
import { COLOR_PARAMS, createEffect, EFFECT_MAP, EFFECTS, FILTER_PRESETS, NEUTRAL_COLOR, type EffectParamDef } from '@/core/effects';
import { setSpeed } from '@/core/ops';
import type { AnimationPreset, AudibleClip, BlendMode, CaptionStyle, Clip, FitMode, ShapeClip, TextClip, TextStyle, VisualClip, AdjustmentClip } from '@/core/types';
import { BUNDLED_FONTS, customFontFamilies, resolveWeight, SYSTEM_FONTS } from '@/engine/fonts';
import { formatShort } from '@/core/time';
import * as A from '@/state/actions';
import { DEFAULT_SILENCE, type SilenceOptions } from '@/core/silence';
import { findSilences, removeSilencesFromClip } from '@/state/silenceTools';
import { duckUnderSpeech } from '@/state/duckingTools';
import { setNoiseReduction, type NoiseLevel } from '@/state/denoiseTools';
import { splitAtScenes } from '@/state/sceneTools';
import { DEFAULT_DUCK } from '@/core/ducking';
import { editor, useEditor } from '@/state/store';
import { ColorField, NumberField, Row, Section, Segmented, SliderRow, Switch } from '../common/fields';
import { openMenuBelow, type MenuItem } from '../common/Menu';
import { AnimProp, clipEditor, KeyframeToggle, useLocalTime, VolumeProp } from './parts';
import { evalProp, hasKeyframes, writeProp } from '@/core/keyframes';

/* ----------------------------- Transform ----------------------------- */

const BLEND_MODES: { value: BlendMode; label: string }[] = [
  { value: 'normal', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'softLight', label: 'Soft light' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' },
  { value: 'add', label: 'Add' },
  { value: 'difference', label: 'Difference' },
];

export function TransformSection({ clip }: { clip: VisualClip }) {
  const W = useEditor((s) => s.project.settings.width);
  const H = useEditor((s) => s.project.settings.height);
  const ed = clipEditor(clip.id, 'Change layout');
  const isMedia = clip.type === 'video' || clip.type === 'image';
  return (
    <Section title="Transform" id="transform">
      <div className="xy-row">
        <XYField clip={clip} path="transform.x" label="X" />
        <XYField clip={clip} path="transform.y" label="Y" />
      </div>
      <AnimProp clip={clip} path="transform.scale" label="Scale" min={0.05} max={4} step={0.01} unit="%" scale={100} defaultValue={1} />
      <AnimProp clip={clip} path="transform.rotation" label="Rotation" min={-180} max={180} step={1} unit="°" defaultValue={0} />
      <AnimProp clip={clip} path="transform.opacity" label="Opacity" min={0} max={1} step={0.01} unit="%" scale={100} defaultValue={1} />
      {isMedia && (
        <Row label="Fit">
          <Segmented<FitMode>
            ariaLabel="Fit mode"
            value={clip.fit}
            onChange={(v) => ed.change((c) => void ((c as VisualClip).fit = v))}
            options={[
              { value: 'contain', label: 'Fit', tip: 'Show the whole frame (letterbox)' },
              { value: 'cover', label: 'Fill', tip: 'Fill the canvas (crop edges)' },
              { value: 'fill', label: 'Stretch', tip: 'Stretch to the canvas' },
            ]}
          />
        </Row>
      )}
      <Row label="Align">
        <div className="segmented" role="group" aria-label="Quick position">
          <button
            onClick={() =>
              ed.change((c) => {
                const v = c as VisualClip;
                v.transform.x = 0;
                v.transform.y = 0;
                delete v.keyframes['transform.x'];
                delete v.keyframes['transform.y'];
              })
            }
            data-tip="Center"
            aria-label="Center"
          >
            Center
          </button>
          <button
            onClick={() =>
              ed.change((c) => {
                const v = c as VisualClip;
                v.transform = { ...v.transform, x: 0, y: 0, scale: 1, rotation: 0 };
                for (const k of ['transform.x', 'transform.y', 'transform.scale', 'transform.rotation']) delete v.keyframes[k];
              })
            }
            data-tip="Reset position, scale and rotation"
            aria-label="Reset transform"
          >
            <RotateCcw size={12} /> Reset
          </button>
        </div>
      </Row>
      <Row label="Flip">
        <button className={`icon-btn small${clip.flipH ? ' active' : ''}`} aria-pressed={clip.flipH} aria-label="Flip horizontally" data-tip="Flip horizontally" onClick={() => ed.change((c) => void ((c as VisualClip).flipH = !clip.flipH))}>
          <FlipHorizontal2 size={15} />
        </button>
        <button className={`icon-btn small${clip.flipV ? ' active' : ''}`} aria-pressed={clip.flipV} aria-label="Flip vertically" data-tip="Flip vertically" onClick={() => ed.change((c) => void ((c as VisualClip).flipV = !clip.flipV))}>
          <FlipVertical2 size={15} />
        </button>
      </Row>
      <Row label="Blend">
        <select className="select" aria-label="Blend mode" value={clip.blendMode} onChange={(e) => ed.change((c) => void ((c as VisualClip).blendMode = e.target.value as BlendMode))}>
          {BLEND_MODES.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
      </Row>
      <SliderRow
        label="Corners"
        value={clip.cornerRadius}
        min={0}
        max={0.5}
        step={0.01}
        unit="%"
        scale={200}
        defaultValue={0}
        onBegin={ed.begin}
        onEnd={ed.end}
        onChange={(v) => ed.change((c) => void ((c as VisualClip).cornerRadius = v))}
      />
      <p className="subtle insp-note">
        Canvas {W}×{H}. Drag the layer in the preview to move it; corners scale, the top handle rotates.
      </p>
    </Section>
  );
}

function XYField({ clip, path, label }: { clip: Clip; path: string; label: string }) {
  const animated = hasKeyframes(clip, path);
  const lt = useLocalTime(clip, animated);
  const ed = clipEditor(clip.id, 'Move layer');
  return (
    <div className="xy-field">
      <NumberField
        label={label}
        value={evalProp(clip, path, lt)}
        step={1}
        unit="px"
        onBegin={ed.begin}
        onEnd={ed.end}
        onChange={(n) => ed.change((c, t) => writeProp(c, path, t, n))}
      />
      <KeyframeToggle clip={clip} path={path} />
    </div>
  );
}

/* ------------------------------- Scenes ------------------------------ */

export function ScenesSection({ clipId }: { clipId: string }) {
  const [sensitivity, setSensitivity] = useState(0.5);
  const [progress, setProgress] = useState<number | null>(null);
  return (
    <Section title="Scenes" id="scenes" defaultOpen={false}>
      <SliderRow label="Sensitivity" value={sensitivity} min={0} max={1} step={0.05} unit="%" scale={100} onChange={setSensitivity} />
      <button
        className="btn small block"
        disabled={progress !== null}
        onClick={async () => {
          setProgress(0);
          try {
            await splitAtScenes(clipId, sensitivity, setProgress);
          } finally {
            setProgress(null);
          }
        }}
      >
        {progress !== null ? `Analyzing… ${Math.round(progress * 100)}%` : 'Detect & split at scene changes'}
      </button>
      <p className="subtle insp-note">Finds hard cuts between shots in this clip (for example in a long recording or an old edit) and splits the clip at each one.</p>
    </Section>
  );
}

/* -------------------------------- Crop ------------------------------- */

export function CropSection({ clip }: { clip: VisualClip }) {
  const ed = clipEditor(clip.id, 'Reset crop');
  const any = clip.crop.left || clip.crop.right || clip.crop.top || clip.crop.bottom || ['crop.left', 'crop.right', 'crop.top', 'crop.bottom'].some((k) => clip.keyframes[k]);
  return (
    <Section
      title="Crop"
      id="crop"
      defaultOpen={false}
      actions={
        any ? (
          <button
            className="icon-btn tiny"
            aria-label="Reset crop"
            data-tip="Reset crop"
            onClick={() =>
              ed.change((c) => {
                (c as VisualClip).crop = { left: 0, right: 0, top: 0, bottom: 0 };
                for (const k of ['crop.left', 'crop.right', 'crop.top', 'crop.bottom']) delete c.keyframes[k];
              })
            }
          >
            <RotateCcw size={12} />
          </button>
        ) : null
      }
    >
      <CropModeButton />
      <AnimProp clip={clip} path="crop.left" label="Left" min={0} max={0.95} unit="%" scale={100} defaultValue={0} />
      <AnimProp clip={clip} path="crop.right" label="Right" min={0} max={0.95} unit="%" scale={100} defaultValue={0} />
      <AnimProp clip={clip} path="crop.top" label="Top" min={0} max={0.95} unit="%" scale={100} defaultValue={0} />
      <AnimProp clip={clip} path="crop.bottom" label="Bottom" min={0} max={0.95} unit="%" scale={100} defaultValue={0} />
    </Section>
  );
}

function CropModeButton() {
  const cropMode = useEditor((s) => s.cropMode);
  const set = useEditor((s) => s.set);
  return (
    <button className={`btn small block${cropMode ? ' primary' : ''}`} aria-pressed={cropMode} onClick={() => set('cropMode', !cropMode)}>
      <Crop size={13} /> {cropMode ? 'Done cropping' : 'Crop in preview'}
    </button>
  );
}

/* ------------------------------- Color ------------------------------- */

export function ColorSection({ clip }: { clip: VisualClip | AdjustmentClip }) {
  const ed = clipEditor(clip.id, 'Reset color');
  return (
    <>
      <Section title="Looks" id="looks">
        <div className="filter-strip">
          {FILTER_PRESETS.map((f) => (
            <button key={f.id} className="filter-chip" onClick={() => A.applyFilterPreset(f.id, [clip.id])} data-tip={f.name} aria-label={`Apply ${f.name} look`}>
              <span style={{ background: f.swatch }} />
              {f.name}
            </button>
          ))}
        </div>
      </Section>
      <Section
        title="Color correction"
        id="color"
        actions={
          <button
            className="icon-btn tiny"
            aria-label="Reset color"
            data-tip="Reset color"
            onClick={() =>
              ed.change((c) => {
                (c as VisualClip).color = { ...NEUTRAL_COLOR };
                for (const k of Object.keys(c.keyframes)) if (k.startsWith('color.')) delete c.keyframes[k];
              })
            }
          >
            <RotateCcw size={12} />
          </button>
        }
      >
        {COLOR_PARAMS.map((p) => (
          <AnimProp key={p.key} clip={clip} path={`color.${p.key}`} label={p.label} min={p.min} max={p.max} step={p.step} scale={p.key === 'hue' ? 1 : 100} unit={p.key === 'hue' ? '°' : p.key === 'exposure' ? '' : ''} defaultValue={0} />
        ))}
      </Section>
    </>
  );
}

/* ------------------------------ Effects ------------------------------ */

export function EffectsSection({ clip }: { clip: VisualClip | AdjustmentClip }) {
  const add = (e: React.MouseEvent<HTMLButtonElement>) => {
    const items: MenuItem[] = [];
    let cat = '';
    for (const fx of EFFECTS) {
      if (fx.category !== cat) {
        cat = fx.category;
        items.push({ kind: 'label', label: cat });
      }
      items.push({
        label: fx.name,
        onClick: () =>
          editor().commit('Add effect', (d) => {
            const c = d.clips[clip.id];
            if (c && 'effects' in c) c.effects.push(createEffect(fx.type));
          }),
      });
    }
    openMenuBelow(e.currentTarget, items, 'right');
  };
  return (
    <Section
      title={`Effects${clip.effects.length ? ` (${clip.effects.length})` : ''}`}
      id="effects"
      actions={
        <button className="btn small" onClick={add} aria-haspopup="menu">
          <Plus size={13} /> Add
        </button>
      }
    >
      {clip.effects.length === 0 && <p className="subtle insp-note">No effects yet. Add one here or drag from the Effects library.</p>}
      {clip.effects.map((fx, i) => {
        const def = EFFECT_MAP[fx.type];
        if (!def) return null;
        const move = (dir: -1 | 1) =>
          editor().commit('Reorder effects', (d) => {
            const c = d.clips[clip.id];
            if (!c || !('effects' in c)) return;
            const j = i + dir;
            if (j < 0 || j >= c.effects.length) return;
            const [x] = c.effects.splice(i, 1);
            c.effects.splice(j, 0, x);
          });
        return (
          <div key={fx.id} className={`fx-card${fx.enabled ? '' : ' off'}`}>
            <div className="fx-head">
              <button
                className="icon-btn tiny"
                aria-label={fx.enabled ? `Disable ${def.name}` : `Enable ${def.name}`}
                data-tip={fx.enabled ? 'Disable' : 'Enable'}
                onClick={() =>
                  editor().commit('Toggle effect', (d) => {
                    const c = d.clips[clip.id];
                    const f = c && 'effects' in c ? c.effects.find((x) => x.id === fx.id) : undefined;
                    if (f) f.enabled = !f.enabled;
                  })
                }
              >
                {fx.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <strong className="grow ellipsis">{def.name}</strong>
              <button className="icon-btn tiny" aria-label="Move effect up" disabled={i === 0} onClick={() => move(-1)}>
                <ArrowUp size={12} />
              </button>
              <button className="icon-btn tiny" aria-label="Move effect down" disabled={i === clip.effects.length - 1} onClick={() => move(1)}>
                <ArrowDown size={12} />
              </button>
              <button
                className="icon-btn tiny"
                aria-label={`Remove ${def.name}`}
                data-tip="Remove"
                onClick={() =>
                  editor().commit('Remove effect', (d) => {
                    const c = d.clips[clip.id];
                    if (!c || !('effects' in c)) return;
                    c.effects = c.effects.filter((x) => x.id !== fx.id);
                    for (const k of Object.keys(c.keyframes)) if (k.startsWith(`fx.${fx.id}.`)) delete c.keyframes[k];
                  })
                }
              >
                <Trash2 size={12} />
              </button>
            </div>
            {def.params.map((p) => (
              <EffectParam key={p.key} clip={clip} fxId={fx.id} def={p} value={fx.params[p.key]} />
            ))}
          </div>
        );
      })}
    </Section>
  );
}

function EffectParam({ clip, fxId, def, value }: { clip: Clip; fxId: string; def: EffectParamDef; value: number | string | boolean | undefined }) {
  const path = `fx.${fxId}.${def.key}`;
  const ed = clipEditor(clip.id, `Change ${def.label.toLowerCase()}`);
  const setParam = (v: number | string | boolean) =>
    ed.change((c) => {
      const f = 'effects' in c ? c.effects.find((x) => x.id === fxId) : undefined;
      if (f) f.params[def.key] = v;
    });
  switch (def.kind) {
    case 'number':
      return <AnimProp clip={clip} path={path} label={def.label} min={def.min} max={def.max} step={def.step} unit={def.unit} defaultValue={def.default} />;
    case 'color':
      return (
        <Row label={def.label}>
          <ColorField ariaLabel={def.label} value={String(value ?? def.default)} onChange={(v) => v && setParam(v)} />
        </Row>
      );
    case 'boolean':
      return (
        <Row label={def.label}>
          <Switch label={def.label} checked={!!value} onChange={setParam} />
        </Row>
      );
    case 'select':
      return (
        <Row label={def.label}>
          <select className="select" aria-label={def.label} value={String(value ?? def.default)} onChange={(e) => setParam(e.target.value)}>
            {def.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Row>
      );
  }
}

/* ----------------------------- Animation ----------------------------- */

const PRESETS: { value: AnimationPreset; label: string; textOnly?: boolean }[] = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'slideUp', label: 'Slide up' },
  { value: 'slideDown', label: 'Slide down' },
  { value: 'slideLeft', label: 'Slide left' },
  { value: 'slideRight', label: 'Slide right' },
  { value: 'zoomIn', label: 'Zoom in' },
  { value: 'zoomOut', label: 'Zoom out' },
  { value: 'pop', label: 'Pop' },
  { value: 'spin', label: 'Spin' },
  { value: 'blur', label: 'Blur' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'typewriter', label: 'Typewriter', textOnly: true },
  { value: 'wordByWord', label: 'Word by word', textOnly: true },
];

export function AnimationSection({ clip }: { clip: VisualClip }) {
  const ed = clipEditor(clip.id, 'Change animation');
  const opts = PRESETS.filter((p) => !p.textOnly || clip.type === 'text');
  const maxDur = Math.max(0.1, Math.min(10, clip.duration));
  const row = (which: 'animIn' | 'animOut', label: string) => (
    <>
      <Row label={label}>
        <select
          className="select"
          aria-label={`${label} animation`}
          value={clip[which].preset}
          onChange={(e) => ed.change((c) => void ((c as VisualClip)[which] = { ...(c as VisualClip)[which], preset: e.target.value as AnimationPreset }))}
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Row>
      {clip[which].preset !== 'none' && (
        <SliderRow
          label="Duration"
          value={Math.min(clip[which].duration, maxDur)}
          min={0.1}
          max={maxDur}
          step={0.05}
          unit="s"
          onBegin={ed.begin}
          onEnd={ed.end}
          onChange={(v) => ed.change((c) => void ((c as VisualClip)[which] = { ...(c as VisualClip)[which], duration: v }))}
        />
      )}
    </>
  );
  return (
    <Section title="Animation" id="animation">
      {row('animIn', 'In')}
      {row('animOut', 'Out')}
      <p className="subtle insp-note">For custom motion, use the ◇ buttons next to any property to set keyframes at the playhead.</p>
    </Section>
  );
}

/* -------------------------------- Text ------------------------------- */

export function fontOptions(): { label: string; families: string[] }[] {
  const groups: Record<string, string[]> = { sans: [], serif: [], display: [], script: [], mono: [] };
  for (const f of BUNDLED_FONTS) groups[f.category].push(f.family);
  const out = [
    { label: 'Sans serif', families: groups.sans },
    { label: 'Serif', families: groups.serif },
    { label: 'Display', families: groups.display },
    { label: 'Handwriting', families: groups.script },
    { label: 'Monospace', families: groups.mono },
    { label: 'System', families: SYSTEM_FONTS },
  ];
  const custom = customFontFamilies();
  if (custom.length) out.unshift({ label: 'Your fonts', families: custom });
  return out;
}

export function weightsFor(family: string): number[] {
  const f = BUNDLED_FONTS.find((x) => x.family === family);
  if (!f) return [400, 700];
  return [...new Set(f.faces.filter((x) => !x.italic).map((x) => x.weight))].sort((a, b) => a - b);
}

const WEIGHT_NAMES: Record<number, string> = { 100: 'Thin', 200: 'Extra light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semibold', 700: 'Bold', 800: 'Extra bold', 900: 'Black' };

/** Typography controls shared by text clips and caption styles. */
export function TextStyleEditor({ style, onChange, onBegin, onEnd }: { style: TextStyle; onChange: (patch: Partial<TextStyle>) => void; onBegin: () => void; onEnd: () => void }) {
  const weights = weightsFor(style.fontFamily);
  const r = resolveWeight(style.fontFamily, style.fontWeight, style.italic);
  return (
    <>
      <Row label="Font">
        <select className="select" aria-label="Font family" value={style.fontFamily} onChange={(e) => onChange({ fontFamily: e.target.value })} style={{ fontFamily: `"${style.fontFamily}"` }}>
          {fontOptions().map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.families.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Row>
      <Row label="Weight">
        <select className="select" aria-label="Font weight" value={r.weight} onChange={(e) => onChange({ fontWeight: Number(e.target.value) })}>
          {weights.map((w) => (
            <option key={w} value={w}>
              {WEIGHT_NAMES[w] ?? w}
            </option>
          ))}
        </select>
        <button className={`icon-btn small${style.italic ? ' active' : ''}`} aria-pressed={style.italic} aria-label="Italic" data-tip="Italic" onClick={() => onChange({ italic: !style.italic })}>
          <Italic size={14} />
        </button>
        <button className={`icon-btn small${style.uppercase ? ' active' : ''}`} aria-pressed={style.uppercase} aria-label="All caps" data-tip="All caps" onClick={() => onChange({ uppercase: !style.uppercase })}>
          <CaseUpper size={15} />
        </button>
      </Row>
      <SliderRow label="Size" value={style.fontSize} min={8} max={400} step={1} unit="px" onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ fontSize: v })} />
      <Row label="Color">
        <ColorField ariaLabel="Text color" value={style.color} onChange={(v) => v && onChange({ color: v })} onBegin={onBegin} onEnd={onEnd} />
      </Row>
      <Row label="Align">
        <Segmented
          ariaLabel="Text alignment"
          value={style.align}
          onChange={(v) => onChange({ align: v })}
          options={[
            { value: 'left', label: <AlignLeft size={14} />, tip: 'Left' },
            { value: 'center', label: <AlignCenter size={14} />, tip: 'Center' },
            { value: 'right', label: <AlignRight size={14} />, tip: 'Right' },
          ]}
        />
      </Row>
      <SliderRow label="Line height" value={style.lineHeight} min={0.7} max={3} step={0.05} defaultValue={1.15} onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ lineHeight: v })} />
      <SliderRow label="Spacing" value={style.letterSpacing} min={-0.1} max={1} step={0.01} unit="em" defaultValue={0} onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ letterSpacing: v })} />
      <SliderRow label="Wrap width" value={style.maxWidth} min={0.1} max={1} step={0.01} unit="%" scale={100} defaultValue={0.9} onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ maxWidth: v })} />
      <div className="insp-sub">Outline</div>
      <Row label="Color">
        <ColorField ariaLabel="Outline color" value={style.strokeColor} onChange={(v) => v && onChange({ strokeColor: v })} onBegin={onBegin} onEnd={onEnd} />
      </Row>
      <SliderRow label="Width" value={style.strokeWidth} min={0} max={30} step={0.5} unit="px" defaultValue={0} onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ strokeWidth: v })} />
      <div className="insp-sub">Shadow</div>
      <Row label="Color">
        <ColorField ariaLabel="Shadow color" value={style.shadowColor} onChange={(v) => v && onChange({ shadowColor: v })} onBegin={onBegin} onEnd={onEnd} />
      </Row>
      <SliderRow label="Blur" value={style.shadowBlur} min={0} max={80} step={1} unit="px" defaultValue={0} onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ shadowBlur: v })} />
      {style.shadowBlur > 0 && (
        <div className="xy-row">
          <NumberField label="X" value={style.shadowX} step={1} onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ shadowX: v })} />
          <NumberField label="Y" value={style.shadowY} step={1} onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ shadowY: v })} />
        </div>
      )}
      <div className="insp-sub">Background box</div>
      <Row label="Color">
        <ColorField ariaLabel="Background color" allowNone value={style.backgroundColor} onChange={(v) => onChange({ backgroundColor: v })} onBegin={onBegin} onEnd={onEnd} />
      </Row>
      {style.backgroundColor && (
        <>
          <SliderRow label="Opacity" value={style.backgroundOpacity} min={0} max={1} step={0.01} unit="%" scale={100} onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ backgroundOpacity: v })} />
          <SliderRow label="Padding" value={style.backgroundPadding} min={0} max={1.5} step={0.01} onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ backgroundPadding: v })} />
          <SliderRow label="Roundness" value={style.backgroundRadius} min={0} max={1} step={0.01} onBegin={onBegin} onEnd={onEnd} onChange={(v) => onChange({ backgroundRadius: v })} />
        </>
      )}
    </>
  );
}

export function TextSection({ clip }: { clip: TextClip }) {
  const ed = clipEditor(clip.id, 'Edit text');
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Section title="Text" id="text">
      <textarea
        id="text-content-input"
        className="input"
        rows={3}
        aria-label="Text content"
        value={draft ?? clip.text}
        onFocus={() => setDraft(clip.text)}
        onChange={(e) => {
          setDraft(e.target.value);
          // Live preview while typing; folded into one undo step on blur.
          const v = e.target.value;
          if (!editor().gestureBase) editor().beginGesture('Edit text');
          editor().updateGesture((d) => {
            const c = d.clips[clip.id];
            if (c?.type === 'text') {
              c.text = v;
              c.name = v.split('\n')[0].slice(0, 40) || 'Text';
            }
          });
        }}
        onBlur={() => {
          setDraft(null);
          editor().endGesture();
        }}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <TextStyleEditor style={clip.style} onBegin={ed.begin} onEnd={ed.end} onChange={(patch) => ed.change((c) => c.type === 'text' && Object.assign(c.style, patch))} />
    </Section>
  );
}

export function CaptionStyleSection({ trackId, style }: { trackId: string; style: CaptionStyle }) {
  const label = 'Caption style';
  const begin = () => editor().beginGesture(label);
  const end = () => editor().endGesture();
  const change = (patch: Partial<CaptionStyle>) => {
    const apply = (d: Parameters<Parameters<ReturnType<typeof editor>['commit']>[1]>[0]) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (t?.captionStyle) Object.assign(t.captionStyle, patch);
    };
    if (editor().gestureBase) editor().updateGesture(apply);
    else editor().commit(label, apply);
  };
  return (
    <Section title="Caption style" id="caption-style">
      <Row label="Position">
        <Segmented
          ariaLabel="Caption position"
          value={style.position}
          onChange={(v) => change({ position: v })}
          options={[
            { value: 'top', label: 'Top' },
            { value: 'middle', label: 'Middle' },
            { value: 'bottom', label: 'Bottom' },
          ]}
        />
      </Row>
      {style.position !== 'middle' && <SliderRow label="Margin" value={style.margin} min={0} max={0.4} step={0.005} unit="%" scale={100} onBegin={begin} onEnd={end} onChange={(v) => change({ margin: v })} />}
      <Row label="Active word">
        <ColorField ariaLabel="Active word highlight color" allowNone value={style.activeWordColor} onChange={(v) => change({ activeWordColor: v })} />
      </Row>
      <TextStyleEditor style={style} onBegin={begin} onEnd={end} onChange={change} />
    </Section>
  );
}

/* ------------------------------- Shape ------------------------------- */

export function ShapeSection({ clip }: { clip: ShapeClip }) {
  const ed = clipEditor(clip.id, 'Edit shape');
  const set = (patch: Partial<ShapeClip>) => ed.change((c) => c.type === 'shape' && Object.assign(c, patch));
  return (
    <Section title="Shape" id="shape">
      <Row label="Type">
        <select className="select" aria-label="Shape type" value={clip.shape} onChange={(e) => set({ shape: e.target.value as ShapeClip['shape'] })}>
          {['rectangle', 'ellipse', 'triangle', 'star', 'line', 'arrow'].map((s) => (
            <option key={s} value={s}>
              {s[0].toUpperCase() + s.slice(1)}
            </option>
          ))}
        </select>
      </Row>
      <div className="xy-row">
        <NumberField label="W" value={clip.width} min={1} max={8000} step={1} unit="px" onBegin={ed.begin} onEnd={ed.end} onChange={(v) => set({ width: v })} />
        <NumberField label="H" value={clip.height} min={1} max={8000} step={1} unit="px" onBegin={ed.begin} onEnd={ed.end} onChange={(v) => set({ height: v })} />
      </div>
      <Row label="Fill">
        <ColorField ariaLabel="Fill color" value={clip.fill} onChange={(v) => v && set({ fill: v })} onBegin={ed.begin} onEnd={ed.end} />
      </Row>
      <Row label="Gradient">
        <ColorField ariaLabel="Gradient end color" allowNone value={clip.fill2} onChange={(v) => set({ fill2: v })} onBegin={ed.begin} onEnd={ed.end} />
      </Row>
      {clip.fill2 && <SliderRow label="Angle" value={clip.gradientAngle} min={0} max={360} step={1} unit="°" onBegin={ed.begin} onEnd={ed.end} onChange={(v) => set({ gradientAngle: v })} />}
      {clip.shape === 'rectangle' && <SliderRow label="Radius" value={clip.radius} min={0} max={Math.min(clip.width, clip.height) / 2} step={1} unit="px" onBegin={ed.begin} onEnd={ed.end} onChange={(v) => set({ radius: v })} />}
      <Row label="Outline">
        <ColorField ariaLabel="Outline color" value={clip.strokeColor} onChange={(v) => v && set({ strokeColor: v })} onBegin={ed.begin} onEnd={ed.end} />
      </Row>
      <SliderRow label="Width" value={clip.strokeWidth} min={0} max={60} step={0.5} unit="px" onBegin={ed.begin} onEnd={ed.end} onChange={(v) => set({ strokeWidth: v })} />
    </Section>
  );
}

/* ------------------------------- Audio ------------------------------- */

export function AudioSection({ clip }: { clip: AudibleClip }) {
  const ed = clipEditor(clip.id, 'Change audio');
  const asset = useEditor((s) => s.project.assets[clip.assetId]);
  if (!asset?.audio) {
    return (
      <Section title="Audio" id="audio">
        <p className="subtle insp-note">This clip has no audio track.</p>
      </Section>
    );
  }
  const maxFade = Math.max(0.1, Math.min(10, clip.duration / 2));
  return (
    <Section title="Audio" id="audio">
      <Row label="Mute">
        <Switch label="Mute clip" checked={clip.muted} onChange={(v) => ed.change((c) => void ((c as AudibleClip).muted = v))} />
        {clip.type === 'video' && (
          <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => A.detachAudioSelection()} data-tip="Move audio to its own clip">
            <Unlink size={12} /> Detach
          </button>
        )}
      </Row>
      <VolumeProp clip={clip} />
      {asset.audio.conformed && <NoiseControl clip={clip} level={clip.denoise ? asset.audio.denoise ?? 'medium' : 'off'} />}
      <AnimProp clip={clip} path="pan" label="Pan" min={-1} max={1} step={0.01} scale={100} defaultValue={0} />
      <SliderRow label="Fade in" value={Math.min(clip.fadeIn, maxFade)} min={0} max={maxFade} step={0.05} unit="s" defaultValue={0} onBegin={ed.begin} onEnd={ed.end} onChange={(v) => ed.change((c) => void ((c as AudibleClip).fadeIn = v))} />
      <SliderRow label="Fade out" value={Math.min(clip.fadeOut, maxFade)} min={0} max={maxFade} step={0.05} unit="s" defaultValue={0} onBegin={ed.begin} onEnd={ed.end} onChange={(v) => ed.change((c) => void ((c as AudibleClip).fadeOut = v))} />
      {!asset.audio.conformed && <p className="subtle insp-note">Preparing audio… you’ll hear it as soon as it’s ready.</p>}
      {asset.audio.conformed && <DuckUnder clipId={clip.id} />}
      {asset.audio.conformed && <RemovePauses clipId={clip.id} />}
    </Section>
  );
}

function NoiseControl({ clip, level }: { clip: AudibleClip; level: NoiseLevel }) {
  const [progress, setProgress] = useState<number | null>(null);
  const choose = async (v: NoiseLevel) => {
    setProgress(0);
    try {
      await setNoiseReduction(clip.id, v, setProgress);
    } finally {
      setProgress(null);
    }
  };
  return (
    <>
      <Row label="Denoise">
        <Segmented<NoiseLevel>
          ariaLabel="Noise reduction"
          value={level}
          onChange={(v) => void choose(v)}
          options={[
            { value: 'off', label: 'Off' },
            { value: 'light', label: 'Light', tip: 'Gentle cleanup of hiss and hum' },
            { value: 'medium', label: 'Medium', tip: 'Removes steady background noise' },
            { value: 'strong', label: 'Strong', tip: 'Aggressive; may thin out the voice' },
          ]}
        />
      </Row>
      {progress !== null && (
        <div className="row" style={{ fontSize: 12 }} role="status">
          <span className="spinner" /> Cleaning up audio… {Math.round(progress * 100)}%
        </div>
      )}
    </>
  );
}

function DuckUnder({ clipId }: { clipId: string }) {
  const [amount, setAmount] = useState(DEFAULT_DUCK.amountDb);
  const [threshold, setThreshold] = useState(-38);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <div className="insp-sub">Duck under speech</div>
      <SliderRow label="Lower by" value={amount} min={-30} max={-3} step={1} unit="dB" onChange={setAmount} />
      <SliderRow label="Speech above" value={threshold} min={-60} max={-15} step={1} unit="dB" onChange={setThreshold} />
      <button
        className="btn small block"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await duckUnderSpeech(clipId, { ...DEFAULT_DUCK, amountDb: amount, thresholdDb: threshold });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Analyzing…' : 'Duck this clip under other audio'}
      </button>
      <p className="subtle insp-note">For background music: lowers it automatically wherever voiceover or dialogue plays, using volume keyframes you can fine-tune.</p>
    </>
  );
}

function RemovePauses({ clipId }: { clipId: string }) {
  const [opts, setOpts] = useState<SilenceOptions>(DEFAULT_SILENCE);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ n: number; total: number } | null>(null);
  const run = async (apply: boolean) => {
    setBusy(true);
    try {
      if (apply) await removeSilencesFromClip(clipId, opts);
      else {
        const r = await findSilences(clipId, opts);
        setFound({ n: r.length, total: r.reduce((a, x) => a + x.end - x.start, 0) });
      }
    } catch (e) {
      setFound(null);
      console.warn(e);
    } finally {
      setBusy(false);
    }
    if (apply) setFound(null);
  };
  return (
    <>
      <div className="insp-sub">Remove pauses</div>
      <SliderRow label="Quieter than" value={opts.thresholdDb} min={-70} max={-15} step={1} unit="dB" onChange={(v) => { setOpts({ ...opts, thresholdDb: v }); setFound(null); }} />
      <SliderRow label="Longer than" value={opts.minSilence} min={0.2} max={3} step={0.05} unit="s" onChange={(v) => { setOpts({ ...opts, minSilence: v }); setFound(null); }} />
      <SliderRow label="Keep" value={opts.padding} min={0} max={0.5} step={0.01} unit="s" onChange={(v) => { setOpts({ ...opts, padding: v }); setFound(null); }} />
      <div className="row">
        <button className="btn small grow" disabled={busy} onClick={() => void run(false)}>
          {busy ? 'Analyzing…' : 'Find pauses'}
        </button>
        <button className="btn small primary grow" disabled={busy} onClick={() => void run(true)}>
          Remove pauses
        </button>
      </div>
      {found && (
        <p className="subtle insp-note" role="status">
          {found.n === 0 ? 'No pauses found with these settings.' : `Found ${found.n} pause${found.n === 1 ? '' : 's'}, ${found.total.toFixed(1)} s in total.`}
        </p>
      )}
      <p className="subtle insp-note">Cuts out quiet gaps in this clip and closes them up — handy for talking-head videos. Undo brings everything back.</p>
    </>
  );
}

/* ------------------------------- Speed ------------------------------- */

export function SpeedSection({ clip }: { clip: AudibleClip }) {
  const presets = [0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8];
  const apply = (s: number) => editor().commit('Change speed', (d) => setSpeed(d, clip.id, s));
  return (
    <Section title="Speed" id="speed">
      <div className="speed-grid" role="group" aria-label="Speed presets">
        {presets.map((s) => (
          <button key={s} aria-pressed={Math.abs(clip.speed - s) < 1e-6} onClick={() => apply(s)}>
            {s}×
          </button>
        ))}
      </div>
      <Row label="Custom">
        <NumberField value={clip.speed} min={0.1} max={16} step={0.05} unit="×" onChange={apply} ariaLabel="Custom speed" />
      </Row>
      <Row label="Keep pitch">
        <Switch label="Preserve audio pitch" checked={clip.preservePitch} onChange={(v) => editor().commit('Change pitch mode', (d) => void ((d.clips[clip.id] as AudibleClip).preservePitch = v))} />
      </Row>
      <p className="subtle insp-note">
        Duration {formatShort(clip.duration)} · source {formatShort(clip.duration * clip.speed)}
      </p>
      {clip.type === 'video' && (
        <button className="btn small block" onClick={() => A.freezeFrame()}>
          <Snowflake size={13} /> Freeze frame at playhead
        </button>
      )}
    </Section>
  );
}

export function OpacitySection({ clip }: { clip: AdjustmentClip }) {
  return (
    <Section title="Adjustment layer" id="adjustment">
      <AnimProp clip={clip} path="opacity" label="Strength" min={0} max={1} unit="%" scale={100} defaultValue={1} />
      <p className="subtle insp-note">Color and effects here apply to every track below this layer while it’s on the timeline.</p>
    </Section>
  );
}

