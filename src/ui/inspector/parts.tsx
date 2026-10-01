import { ChevronLeft, ChevronRight, Diamond } from 'lucide-react';
import { EASINGS } from '@/core/easing';
import { evalProp, hasKeyframes, keyframeAt, removeKeyframe, toggleAnimation, upsertKeyframe, writeProp, KF_EPS } from '@/core/keyframes';
import type { Clip, Project } from '@/core/types';
import { editor, usePlayback } from '@/state/store';
import { player } from '@/playback/player';
import { openContextMenu } from '../common/Menu';
import { SliderRow } from '../common/fields';

/** Clip-local time at the playhead, clamped to the clip. */
export function localT(c: Clip, t = usePlayback.getState().time): number {
  return Math.min(Math.max(t - c.start, 0), c.duration);
}

/** Subscribe to the playhead only when a value actually changes over time. */
export function useLocalTime(c: Clip, animated: boolean): number {
  const t = usePlayback((s) => (animated ? s.time : 0));
  return animated ? localT(c, t) : localT(c);
}

/**
 * Edits that fold continuous drags into a single undo step. `change` sets
 * absolute values, so applying it repeatedly to the gesture base is safe.
 */
export function clipEditor(clipId: string, label: string) {
  return {
    begin: () => editor().beginGesture(label),
    change: (recipe: (c: Clip, lt: number, d: Project) => void) => {
      const s = editor();
      const apply = (d: Project) => {
        const c = d.clips[clipId];
        if (c) recipe(c, localT(c), d);
      };
      if (s.gestureBase) s.updateGesture(apply);
      else s.commit(label, apply);
    },
    end: () => editor().endGesture(),
  };
}

export function KeyframeToggle({ clip, path }: { clip: Clip; path: string }) {
  const animated = hasKeyframes(clip, path);
  const lt = useLocalTime(clip, animated);
  const at = animated ? keyframeAt(clip, path, lt) : undefined;
  const label = animated ? (at ? 'Remove keyframe' : 'Add keyframe') : 'Animate this property';
  const kfs = clip.keyframes[path] ?? [];
  const prev = [...kfs].reverse().find((k) => k.t < lt - KF_EPS * 20);
  const next = kfs.find((k) => k.t > lt + KF_EPS * 20);

  const toggle = () => {
    editor().commit(label, (d) => {
      const c = d.clips[clip.id];
      if (!c) return;
      const t = localT(c);
      if (!hasKeyframes(c, path)) toggleAnimation(c, path, t);
      else {
        const k = keyframeAt(c, path, t);
        if (k) removeKeyframe(c, path, k.id);
        else upsertKeyframe(c, path, t, evalProp(c, path, t));
      }
    });
  };

  return (
    <span className="kf-ctl">
      {animated && (
        <button className="kf-nav" aria-label="Previous keyframe" disabled={!prev} onClick={() => prev && player.seek(clip.start + prev.t)}>
          <ChevronLeft size={12} />
        </button>
      )}
      <button
        className={`kf-btn${animated ? ' animated' : ''}${at ? ' on' : ''}`}
        aria-label={label}
        data-tip={animated ? `${label} · right-click for easing / stop animating` : label}
        aria-pressed={!!at}
        onClick={toggle}
        onContextMenu={(e) =>
          animated &&
          openContextMenu(e, [
            ...(at
              ? [
                  { kind: 'label' as const, label: 'Easing to next keyframe' },
                  ...EASINGS.map((ez) => ({
                    label: ez.label,
                    checked: at.ease === ez.id,
                    onClick: () =>
                      editor().commit('Change easing', (d) => {
                        const k = d.clips[clip.id]?.keyframes[path]?.find((x) => x.id === at.id);
                        if (k) k.ease = ez.id;
                      }),
                  })),
                  { kind: 'separator' as const },
                ]
              : []),
            {
              label: 'Stop animating (keep current value)',
              onClick: () =>
                editor().commit('Remove animation', (d) => {
                  const c = d.clips[clip.id];
                  if (c) toggleAnimation(c, path, localT(c));
                }),
            },
          ])
        }
      >
        <Diamond size={11} fill={at ? 'currentColor' : 'none'} />
      </button>
      {animated && (
        <button className="kf-nav" aria-label="Next keyframe" disabled={!next} onClick={() => next && player.seek(clip.start + next.t)}>
          <ChevronRight size={12} />
        </button>
      )}
    </span>
  );
}

/** Slider row bound to an animatable clip property path. */
export function AnimProp({
  clip,
  path,
  label,
  min,
  max,
  step = 0.01,
  unit,
  scale = 1,
  defaultValue,
  animatable = true,
}: {
  clip: Clip;
  path: string;
  label: string;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  scale?: number;
  defaultValue?: number;
  animatable?: boolean;
}) {
  const animated = hasKeyframes(clip, path);
  const lt = useLocalTime(clip, animated);
  const value = evalProp(clip, path, lt);
  const ed = clipEditor(clip.id, `Change ${label.toLowerCase()}`);
  return (
    <SliderRow
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      unit={unit}
      scale={scale}
      defaultValue={defaultValue}
      onBegin={ed.begin}
      onEnd={ed.end}
      onChange={(v) => ed.change((c, t) => writeProp(c, path, t, v))}
      trailing={animatable ? <KeyframeToggle clip={clip} path={path} /> : undefined}
    />
  );
}

const MIN_DB = -60;
const MAX_DB = 12;
const toDb = (g: number) => (g <= 0.001 ? MIN_DB : Math.max(MIN_DB, Math.min(MAX_DB, 20 * Math.log10(g))));
const fromDb = (db: number) => (db <= MIN_DB + 0.01 ? 0 : Math.pow(10, db / 20));

/** Volume in decibels (stored as linear gain so mixing stays simple). */
export function VolumeProp({ clip, path = 'volume', label = 'Volume' }: { clip: Clip; path?: string; label?: string }) {
  const animated = hasKeyframes(clip, path);
  const lt = useLocalTime(clip, animated);
  const db = toDb(evalProp(clip, path, lt));
  const ed = clipEditor(clip.id, 'Change volume');
  return (
    <SliderRow
      label={label}
      value={Math.round(db * 10) / 10}
      min={MIN_DB}
      max={MAX_DB}
      step={0.1}
      unit="dB"
      defaultValue={0}
      onBegin={ed.begin}
      onEnd={ed.end}
      onChange={(v) => ed.change((c, t) => writeProp(c, path, t, fromDb(v)))}
      trailing={<KeyframeToggle clip={clip} path={path} />}
    />
  );
}
