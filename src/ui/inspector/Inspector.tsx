import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AudioLines, Captions, Copy, Film, Image as ImageIcon, Layers, Shapes, SlidersHorizontal, Trash2, Type, X } from 'lucide-react';
import { maxTransitionDuration, nextAdjacent } from '@/core/ops';
import { FORMAT_PRESETS, FPS_OPTIONS, projectDuration } from '@/core/project';
import { formatDuration, formatTimecode } from '@/core/time';
import { TRANSITIONS } from '@/core/transitions';
import type { Clip, Track, VisualClip } from '@/core/types';
import { isVisualClip } from '@/core/types';
import * as A from '@/state/actions';
import { editor, useEditor } from '@/state/store';
import { storageInfo, type StorageInfo } from '@/storage/opfs';
import { ColorField, NumberField, Row, Section, SliderRow, Switch } from '../common/fields';
import {
  AnimationSection,
  AudioSection,
  CaptionStyleSection,
  ColorSection,
  CropSection,
  EffectsSection,
  OpacitySection,
  ScenesSection,
  ShapeSection,
  SpeedSection,
  TextSection,
  TransformSection,
} from './sections';
import { clipEditor } from './parts';

type Tab = 'edit' | 'color' | 'effects' | 'audio' | 'speed';

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const selectedTransition = useEditor((s) => s.selectedTransition);
  const selectedTrackId = useEditor((s) => s.selectedTrackId);

  let body: ReactNode;
  if (selectedTransition && project.clips[selectedTransition]) {
    body = <TransitionInspector clipId={selectedTransition} />;
  } else if (selection.length === 1 && project.clips[selection[0]]) {
    body = <ClipInspector clip={project.clips[selection[0]]} />;
  } else if (selection.length > 1) {
    body = <MultiInspector ids={selection} />;
  } else if (selectedTrackId && project.tracks.some((t) => t.id === selectedTrackId)) {
    body = <TrackInspector trackId={selectedTrackId} />;
  } else {
    body = <ProjectInspector />;
  }
  return (
    <aside className="inspector" aria-label="Inspector">
      {body}
    </aside>
  );
}

function InspectorHead({ icon, title, subtitle, actions }: { icon: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="insp-head">
      <span className="insp-icon">{icon}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="insp-title ellipsis">{title}</div>
        {subtitle && <div className="insp-subtitle ellipsis">{subtitle}</div>}
      </div>
      {actions}
    </div>
  );
}

const TYPE_ICON: Record<Clip['type'], ReactNode> = {
  video: <Film size={15} />,
  audio: <AudioLines size={15} />,
  image: <ImageIcon size={15} />,
  text: <Type size={15} />,
  shape: <Shapes size={15} />,
  adjustment: <Layers size={15} />,
  caption: <Captions size={15} />,
};

const TYPE_LABEL: Record<Clip['type'], string> = {
  video: 'Video clip',
  audio: 'Audio clip',
  image: 'Image',
  text: 'Text',
  shape: 'Shape',
  adjustment: 'Adjustment layer',
  caption: 'Caption',
};

function tabsFor(c: Clip): { id: Tab; label: string }[] {
  switch (c.type) {
    case 'video':
      return [
        { id: 'edit', label: 'Video' },
        { id: 'color', label: 'Color' },
        { id: 'effects', label: 'Effects' },
        { id: 'audio', label: 'Audio' },
        { id: 'speed', label: 'Speed' },
      ];
    case 'image':
      return [
        { id: 'edit', label: 'Image' },
        { id: 'color', label: 'Color' },
        { id: 'effects', label: 'Effects' },
      ];
    case 'text':
      return [
        { id: 'edit', label: 'Text' },
        { id: 'effects', label: 'Effects' },
      ];
    case 'shape':
      return [
        { id: 'edit', label: 'Shape' },
        { id: 'color', label: 'Color' },
        { id: 'effects', label: 'Effects' },
      ];
    case 'audio':
      return [
        { id: 'audio', label: 'Audio' },
        { id: 'speed', label: 'Speed' },
      ];
    case 'adjustment':
      return [
        { id: 'color', label: 'Color' },
        { id: 'effects', label: 'Effects' },
      ];
    case 'caption':
      return [{ id: 'edit', label: 'Caption' }];
  }
}

function ClipInspector({ clip }: { clip: Clip }) {
  const tabs = tabsFor(clip);
  const [tab, setTab] = useState<Tab>(tabs[0].id);
  const fps = useEditor((s) => s.project.settings.fps);
  const asset = useEditor((s) => ('assetId' in clip ? s.project.assets[clip.assetId] : undefined));
  useEffect(() => {
    if (!tabs.some((t) => t.id === tab)) setTab(tabs[0].id);
  }, [clip.type]); // eslint-disable-line react-hooks/exhaustive-deps
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const [name, setName] = useState(clip.name);
  useEffect(() => setName(clip.name), [clip.name, clip.id]);

  return (
    <>
      <InspectorHead
        icon={TYPE_ICON[clip.type]}
        title={
          <input
            className="insp-name"
            aria-label="Clip name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== clip.name && editor().commit('Rename clip', (d) => d.clips[clip.id] && (d.clips[clip.id].name = name.slice(0, 120)))}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
          />
        }
        subtitle={
          <>
            {TYPE_LABEL[clip.type]} · {formatTimecode(clip.start, fps)} · {formatDuration(clip.duration)}
            {asset && asset.status !== 'ready' && <span className="badge warn" style={{ marginLeft: 6 }}>{asset.status}</span>}
          </>
        }
        actions={
          <>
            <button className="icon-btn small" aria-label="Duplicate clip" data-tip="Duplicate" data-kbd="⌘D" onClick={() => A.duplicateSelection()}>
              <Copy size={14} />
            </button>
            <button className="icon-btn small" aria-label="Delete clip" data-tip="Delete" data-kbd="Del" onClick={() => A.deleteSelection()}>
              <Trash2 size={14} />
            </button>
          </>
        }
      />
      {tabs.length > 1 && (
        <div className="insp-tabs" role="tablist" aria-label="Clip properties">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={active === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="insp-scroll" role="tabpanel">
        {active === 'edit' && clip.type === 'text' && <TextSection clip={clip} />}
        {active === 'edit' && clip.type === 'shape' && <ShapeSection clip={clip} />}
        {active === 'edit' && isVisualClip(clip) && (
          <>
            <TransformSection clip={clip} />
            <AnimationSection clip={clip} />
            {(clip.type === 'video' || clip.type === 'image') && <CropSection clip={clip as VisualClip} />}
            {clip.type === 'video' && !clip.freeze && <ScenesSection clipId={clip.id} />}
          </>
        )}
        {active === 'edit' && clip.type === 'caption' && <CaptionClipSection clipId={clip.id} />}
        {active === 'color' && (isVisualClip(clip) || clip.type === 'adjustment') && (
          <>
            {clip.type === 'adjustment' && <OpacitySection clip={clip} />}
            <ColorSection clip={clip} />
          </>
        )}
        {active === 'effects' && (isVisualClip(clip) || clip.type === 'adjustment') && <EffectsSection clip={clip} />}
        {active === 'audio' && (clip.type === 'video' || clip.type === 'audio') && <AudioSection clip={clip} />}
        {active === 'speed' && (clip.type === 'video' || clip.type === 'audio') && <SpeedSection clip={clip} />}
      </div>
    </>
  );
}

function CaptionClipSection({ clipId }: { clipId: string }) {
  const clip = useEditor((s) => s.project.clips[clipId]);
  const track = useEditor((s) => s.project.tracks.find((t) => t.id === clip?.trackId));
  const [draft, setDraft] = useState<string | null>(null);
  if (!clip || clip.type !== 'caption') return null;
  return (
    <>
      <Section title="Caption" id="caption">
        <textarea
          className="input"
          rows={3}
          aria-label="Caption text"
          value={draft ?? clip.text}
          onFocus={() => setDraft(clip.text)}
          onChange={(e) => {
            const v = e.target.value;
            setDraft(v);
            editor().commit(
              'Edit caption',
              (d) => {
                const c = d.clips[clipId];
                if (c?.type === 'caption') {
                  c.text = v;
                  c.name = v.slice(0, 40);
                  c.words = undefined;
                }
              },
              { coalesce: `caption:${clipId}` },
            );
          }}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <p className="subtle insp-note">Drag the caption’s edges on the timeline to change when it appears. Style applies to all captions on this track.</p>
      </Section>
      {track?.captionStyle && <CaptionStyleSection trackId={track.id} style={track.captionStyle} />}
    </>
  );
}

function TrackInspector({ trackId }: { trackId: string }) {
  const track = useEditor((s) => s.project.tracks.find((t) => t.id === trackId));
  const clipCount = useEditor((s) => Object.values(s.project.clips).filter((c) => c.trackId === trackId).length);
  if (!track) return null;
  const patch = (label: string, fn: (t: Track) => void) =>
    editor().commit(label, (d) => {
      const t = d.tracks.find((x) => x.id === trackId);
      if (t) fn(t);
    });
  const kindLabel = track.kind === 'video' ? 'Video track' : track.kind === 'audio' ? 'Audio track' : 'Caption track';
  const icon = track.kind === 'video' ? <Film size={15} /> : track.kind === 'audio' ? <AudioLines size={15} /> : <Captions size={15} />;
  return (
    <>
      <InspectorHead icon={icon} title={track.name} subtitle={`${kindLabel} · ${clipCount} clip${clipCount === 1 ? '' : 's'}`} />
      <div className="insp-scroll">
        <Section title="Track" id="track">
          {track.kind !== 'audio' && (
            <Row label="Visible">
              <Switch label="Track visible" checked={!track.hidden} onChange={(v) => patch(v ? 'Show track' : 'Hide track', (t) => void (t.hidden = !v))} />
            </Row>
          )}
          {track.kind !== 'caption' && (
            <Row label="Mute">
              <Switch label="Mute track" checked={track.muted} onChange={(v) => patch(v ? 'Mute track' : 'Unmute track', (t) => void (t.muted = v))} />
            </Row>
          )}
          <Row label="Lock">
            <Switch label="Lock track" checked={track.locked} onChange={(v) => patch(v ? 'Lock track' : 'Unlock track', (t) => void (t.locked = v))} />
          </Row>
          {track.kind !== 'caption' && (
            <SliderRow
              label="Volume"
              value={Math.round(Math.max(-60, 20 * Math.log10(Math.max(track.volume, 0.001))) * 10) / 10}
              min={-60}
              max={12}
              step={0.1}
              unit="dB"
              defaultValue={0}
              onBegin={() => editor().beginGesture('Track volume')}
              onEnd={() => editor().endGesture()}
              onChange={(db) =>
                editor().updateGesture((d) => {
                  const t = d.tracks.find((x) => x.id === trackId);
                  if (t) t.volume = db <= -59.99 ? 0 : Math.pow(10, db / 20);
                })
              }
            />
          )}
          <p className="subtle insp-note">
            {track.kind === 'video'
              ? 'Higher video tracks appear on top. Hiding a track also silences its clips.'
              : track.kind === 'audio'
                ? 'Track volume applies on top of each clip’s own volume.'
                : 'All captions on this track share the style below.'}
          </p>
        </Section>
        {track.captionStyle && <CaptionStyleSection trackId={track.id} style={track.captionStyle} />}
      </div>
    </>
  );
}

function TransitionInspector({ clipId }: { clipId: string }) {
  const project = useEditor((s) => s.project);
  const clip = project.clips[clipId];
  if (!clip || !isVisualClip(clip) || !clip.transitionOut) return null;
  const next = nextAdjacent(project, clip);
  const max = next ? maxTransitionDuration(clip, next) : clip.transitionOut.duration;
  const ed = clipEditor(clipId, 'Change transition');
  return (
    <>
      <InspectorHead
        icon={<SlidersHorizontal size={15} />}
        title="Transition"
        subtitle={`${clip.name} → ${next?.name ?? '—'}`}
        actions={
          <button className="icon-btn small" aria-label="Remove transition" data-tip="Remove transition" onClick={() => A.removeTransition(clipId)}>
            <Trash2 size={14} />
          </button>
        }
      />
      <div className="insp-scroll">
        <Section title="Transition" id="transition">
          <div className="transition-pick" role="radiogroup" aria-label="Transition type">
            {TRANSITIONS.map((t) => (
              <button
                key={t.type}
                role="radio"
                aria-checked={clip.transitionOut!.type === t.type}
                onClick={() => ed.change((c) => isVisualClip(c) && c.transitionOut && (c.transitionOut.type = t.type))}
                data-tip={t.description}
              >
                {t.name}
              </button>
            ))}
          </div>
          <SliderRow
            label="Duration"
            value={clip.transitionOut.duration}
            min={2 / project.settings.fps}
            max={Math.max(2 / project.settings.fps, max)}
            step={1 / project.settings.fps}
            unit="s"
            onBegin={ed.begin}
            onEnd={ed.end}
            onChange={(v) => ed.change((c) => isVisualClip(c) && c.transitionOut && (c.transitionOut.duration = v))}
          />
          <p className="subtle insp-note">The transition is centered on the cut. If a clip has no extra footage beyond the cut, its edge frame is held.</p>
        </Section>
      </div>
    </>
  );
}

function MultiInspector({ ids }: { ids: string[] }) {
  const all = useEditor((s) => s.project.clips);
  const clips = useMemo(() => ids.map((id) => all[id]).filter(Boolean), [ids, all]);
  const audible = clips.filter((c) => c.type === 'video' || c.type === 'audio');
  return (
    <>
      <InspectorHead icon={<Layers size={15} />} title={`${clips.length} clips selected`} subtitle="Changes apply to all selected clips" />
      <div className="insp-scroll">
        <Section title="Actions" id="multi-actions">
          <div className="col">
            <button className="btn small block" onClick={() => A.duplicateSelection()}>
              <Copy size={13} /> Duplicate
            </button>
            <button className="btn small block" onClick={() => A.addTransitionToSelection('crossfade')}>
              Add cross dissolves between them
            </button>
            <button className="btn small block danger" onClick={() => A.deleteSelection()}>
              <Trash2 size={13} /> Delete
            </button>
          </div>
        </Section>
        {audible.length > 0 && (
          <Section title="Speed" id="multi-speed">
            <div className="speed-grid">
              {[0.5, 1, 1.5, 2].map((s) => (
                <button key={s} onClick={() => A.setClipSpeedPreset(s)}>
                  {s}×
                </button>
              ))}
            </div>
          </Section>
        )}
      </div>
    </>
  );
}

function ProjectInspector() {
  const project = useEditor((s) => s.project);
  const set = useEditor((s) => s.set);
  const [storage, setStorage] = useState<StorageInfo | null>(null);
  useEffect(() => {
    void storageInfo().then(setStorage);
  }, [project.assets]);
  const { width, height, fps, background } = project.settings;
  const dur = projectDuration(project);
  const commit = (label: string, fn: (d: typeof project) => void) => editor().commit(label, fn);
  const gb = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
  return (
    <>
      <InspectorHead icon={<Film size={15} />} title="Project" subtitle={`${formatDuration(dur)} · ${Object.keys(project.clips).length} clips`} />
      <div className="insp-scroll">
        <Section title="Canvas" id="project-canvas">
          <Row label="Format">
            <select
              className="select"
              aria-label="Canvas format"
              value={FORMAT_PRESETS.find((p) => p.width === width && p.height === height)?.id ?? 'custom'}
              onChange={(e) => {
                const p = FORMAT_PRESETS.find((x) => x.id === e.target.value);
                if (p)
                  commit('Change format', (d) => {
                    d.settings.width = p.width;
                    d.settings.height = p.height;
                  });
              }}
            >
              {FORMAT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom" disabled>
                Custom
              </option>
            </select>
          </Row>
          <div className="xy-row">
            <NumberField label="W" value={width} min={16} max={7680} step={2} unit="px" onChange={(v) => commit('Change size', (d) => void (d.settings.width = Math.round(v / 2) * 2))} />
            <NumberField label="H" value={height} min={16} max={7680} step={2} unit="px" onChange={(v) => commit('Change size', (d) => void (d.settings.height = Math.round(v / 2) * 2))} />
          </div>
          <Row label="Frame rate">
            <select className="select" aria-label="Frame rate" value={fps} onChange={(e) => commit('Change frame rate', (d) => void (d.settings.fps = Number(e.target.value)))}>
              {FPS_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </Row>
          <Row label="Background">
            <ColorField ariaLabel="Background color" value={background} onChange={(v) => v && commit('Change background', (d) => void (d.settings.background = v))} />
          </Row>
        </Section>
        <Section title="Audio" id="project-audio">
          <SliderRow
            label="Master"
            value={project.masterVolume}
            min={0}
            max={2}
            step={0.01}
            unit="%"
            scale={100}
            defaultValue={1}
            onBegin={() => editor().beginGesture('Master volume')}
            onEnd={() => editor().endGesture()}
            onChange={(v) => editor().updateGesture((d) => void (d.masterVolume = v))}
          />
        </Section>
        <Section title="Range" id="project-range">
          <Row label="In point">
            <span className="mono">{project.inPoint !== null ? formatTimecode(project.inPoint, fps) : '—'}</span>
            {project.inPoint !== null && (
              <button className="icon-btn tiny" aria-label="Clear in point" onClick={() => A.setInPoint(null)}>
                <X size={12} />
              </button>
            )}
          </Row>
          <Row label="Out point">
            <span className="mono">{project.outPoint !== null ? formatTimecode(project.outPoint, fps) : '—'}</span>
            {project.outPoint !== null && (
              <button className="icon-btn tiny" aria-label="Clear out point" onClick={() => A.setOutPoint(null)}>
                <X size={12} />
              </button>
            )}
          </Row>
          <p className="subtle insp-note">Press I and O to set a range for playback and export.</p>
        </Section>
        <Section title="Storage" id="project-storage" defaultOpen={false}>
          {storage ? (
            <>
              <div className="progress" style={{ marginBottom: 6 }}>
                <div style={{ width: `${Math.min(100, (storage.usage / Math.max(1, storage.quota)) * 100)}%` }} />
              </div>
              <p className="subtle insp-note">
                {gb(storage.usage)} used of {gb(storage.quota)} available to this site. {storage.persisted ? 'Storage is persistent.' : 'The browser may clear this data if your disk gets full.'}
              </p>
            </>
          ) : (
            <p className="subtle insp-note">Storage information isn’t available in this browser.</p>
          )}
          <button className="btn small block" onClick={() => set('dialog', 'projects')}>
            Manage projects…
          </button>
        </Section>
        <div className="insp-tip">
          <Type size={14} />
          <span>Select a clip on the timeline to edit it. Press <kbd>?</kbd> to see keyboard shortcuts.</span>
        </div>
      </div>
    </>
  );
}
