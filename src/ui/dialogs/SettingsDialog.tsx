import { useState } from 'react';
import { FORMAT_PRESETS, FPS_OPTIONS } from '@/core/project';
import { newProject } from '@/state/projectManager';
import { editor, useEditor } from '@/state/store';
import { Modal } from '../common/Modal';
import { FormatShape } from '../common/FormatShape';
import { ColorField, NumberField } from '../common/fields';

/** Project settings (edit mode) or new-project setup (new mode). */
export default function SettingsDialog({ mode }: { mode: 'new' | 'edit' }) {
  const settings = useEditor((s) => s.project.settings);
  const projectName = useEditor((s) => s.project.name);
  const [name, setName] = useState(mode === 'new' ? '' : projectName);
  const [w, setW] = useState(mode === 'new' ? 1920 : settings.width);
  const [h, setH] = useState(mode === 'new' ? 1080 : settings.height);
  const [fps, setFps] = useState(mode === 'new' ? 30 : settings.fps);
  const [bg, setBg] = useState(mode === 'new' ? '#000000' : settings.background);
  const close = () => editor().set('dialog', null);
  const even = (n: number) => Math.max(16, Math.min(7680, Math.round(n / 2) * 2));

  const apply = async () => {
    if (mode === 'new') {
      await newProject({ width: even(w), height: even(h), fps, background: bg, chosen: true }, name.trim() || undefined);
    } else {
      editor().commit('Project settings', (d) => {
        d.settings.width = even(w);
        d.settings.height = even(h);
        d.settings.fps = fps;
        d.settings.background = bg;
        d.settings.chosen = true;
      });
      if (name.trim() && name !== projectName) editor().silent((d) => void (d.name = name.trim().slice(0, 120)));
    }
    close();
  };

  return (
    <Modal
      title={mode === 'new' ? 'New project' : 'Project settings'}
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void apply()}>
            {mode === 'new' ? 'Create project' : 'Apply'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 12 }}>
        <div className="field">
          <label htmlFor="proj-name">Name</label>
          <input id="proj-name" className="input" placeholder="Untitled project" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <div className="format-pick" role="group" aria-label="Canvas format" style={{ justifyContent: 'flex-start', marginTop: 0 }}>
          {FORMAT_PRESETS.map((p) => (
            <button
              key={p.id}
              aria-pressed={p.width === w && p.height === h}
              onClick={() => {
                setW(p.width);
                setH(p.height);
              }}
            >
              <FormatShape width={p.width} height={p.height} />
              <span>{p.id}</span>
              <span className="subtle">{p.hint.split(',')[0]}</span>
            </button>
          ))}
        </div>
        <div className="field">
          <span className="label">Size</span>
          <div className="xy-row">
            <NumberField label="W" value={w} min={16} max={7680} step={2} unit="px" onChange={setW} />
            <NumberField label="H" value={h} min={16} max={7680} step={2} unit="px" onChange={setH} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="proj-fps">Frame rate</label>
          <select id="proj-fps" className="select" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
            {FPS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <span className="label">Background</span>
          <ColorField ariaLabel="Background color" value={bg} onChange={(v) => v && setBg(v)} />
        </div>
        {mode === 'edit' && (
          <p className="subtle" style={{ margin: 0, fontSize: 12 }}>
            Changing the size keeps clips centered; existing positions are in pixels from the center.
          </p>
        )}
      </div>
    </Modal>
  );
}
