import { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileDown,
  FileUp,
  FolderOpen,
  Keyboard,
  Loader2,
  Lock,
  PanelRight,
  Plus,
  Redo2,
  Settings,
  Undo2,
} from 'lucide-react';
import { editor, useEditor } from '@/state/store';
import { duplicateProject, renameProject } from '@/state/projectManager';
import { openMenuBelow } from './common/Menu';
import { MOD, SHIFT } from './shortcuts';
import { openImportPicker } from './importPicker';

export function TopBar({ layout }: { layout: 'desktop' | 'tablet' | 'phone' }) {
  const name = useEditor((s) => s.project.name);
  const saveState = useEditor((s) => s.saveState);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label);
  const redoLabel = useEditor((s) => s.future[0]?.label);
  const set = useEditor((s) => s.set);
  const inspectorOpen = useEditor((s) => s.inspectorOpen);
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  const projectMenu = (e: React.MouseEvent<HTMLButtonElement>) =>
    openMenuBelow(e.currentTarget, [
      { label: 'All projects…', icon: <FolderOpen size={14} />, onClick: () => set('dialog', 'projects') },
      { label: 'New project…', icon: <Plus size={14} />, onClick: () => set('dialog', 'newProject') },
      { label: 'Duplicate project', icon: <Copy size={14} />, onClick: () => void duplicateProject(editor().project.id) },
      { kind: 'separator' },
      { label: 'Project settings…', icon: <Settings size={14} />, onClick: () => set('dialog', 'settings') },
      { kind: 'separator' },
      { label: 'Import media…', icon: <FileUp size={14} />, kbd: `${MOD}I`, onClick: () => openImportPicker() },
      {
        label: 'Save project file (with media)…',
        icon: <FileDown size={14} />,
        onClick: () => void import('@/state/projectFile').then((m) => m.exportProjectPackage(true)),
      },
      {
        label: 'Save project file (without media)',
        icon: <FileDown size={14} />,
        onClick: () => void import('@/state/projectFile').then((m) => m.exportProjectPackage(false)),
      },
      { label: 'Open project file…', icon: <FolderOpen size={14} />, onClick: () => openImportPicker({}, '.cutline', false) },
      { kind: 'separator' },
      { label: 'Keyboard shortcuts', icon: <Keyboard size={14} />, kbd: '?', onClick: () => set('dialog', 'shortcuts') },
    ]);

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 64 64">
            <path d="M8 6h14v52H8zM28 6h28v12H28zm0 20h28v12H28zm0 20h28v12H28z" fill="#fff" />
          </svg>
        </div>
        <span className="brand-name">Cutline</span>
      </div>
      <button className="icon-btn small" aria-label="Project menu" data-tip="Project menu" onClick={projectMenu} aria-haspopup="menu">
        <ChevronDown size={16} />
      </button>
      <input
        className="project-name"
        aria-label="Project name"
        value={draft}
        size={Math.max(8, Math.min(36, draft.length + 1))}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => renameProject(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(name);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <SaveIndicator state={saveState} />
      <div className="grow" />
      {layout !== 'phone' && (
        <span className="privacy-pill" data-tip="Your media never leaves this device. Editing and export run in your browser.">
          <Lock size={12} /> Private · on-device
        </span>
      )}
      <div className="sep" />
      <button className="icon-btn" aria-label={canUndo ? `Undo ${undoLabel}` : 'Undo'} data-tip={canUndo ? `Undo ${undoLabel}` : 'Undo'} data-kbd={`${MOD}Z`} disabled={!canUndo} onClick={() => editor().undo()}>
        <Undo2 size={17} />
      </button>
      <button className="icon-btn" aria-label={canRedo ? `Redo ${redoLabel}` : 'Redo'} data-tip={canRedo ? `Redo ${redoLabel}` : 'Redo'} data-kbd={`${MOD}${SHIFT}Z`} disabled={!canRedo} onClick={() => editor().redo()}>
        <Redo2 size={17} />
      </button>
      {layout === 'tablet' && (
        <button className="icon-btn" aria-label="Toggle inspector" aria-pressed={inspectorOpen} data-tip="Inspector" onClick={() => set('inspectorOpen', !inspectorOpen)}>
          <PanelRight size={17} />
        </button>
      )}
      <div className="sep" />
      <button className="btn primary" onClick={() => set('dialog', 'export')} data-tip="Render your video" data-kbd={`${MOD}E`}>
        <Download size={15} />
        {layout === 'phone' ? '' : 'Export'}
      </button>
    </header>
  );
}

function SaveIndicator({ state }: { state: string }) {
  if (state === 'error')
    return (
      <span className="save-state" style={{ color: 'var(--danger)' }} role="status">
        <AlertCircle size={13} />
        <span>Not saved</span>
      </span>
    );
  if (state === 'saving' || state === 'unsaved')
    return (
      <span className="save-state" role="status">
        <Loader2 size={13} className="spin-slow" />
        <span>Saving…</span>
      </span>
    );
  return (
    <span className="save-state" role="status" data-tip="Saved in this browser. Projects survive reloads and work offline.">
      <Check size={13} />
      <span>Saved</span>
    </span>
  );
}
