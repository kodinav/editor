import { useEffect, useState } from 'react';
import { Copy, FolderOpen, MoreHorizontal, Plus, Trash2, Upload } from 'lucide-react';
import { formatDuration } from '@/core/time';
import { listProjects, type ProjectMeta } from '@/storage/db';
import { deleteProject, duplicateProject, flushSave, openProjectById } from '@/state/projectManager';
import { editor, useEditor } from '@/state/store';
import { Modal } from '../common/Modal';
import { openMenuBelow } from '../common/Menu';
import { openImportPicker } from '../importPicker';

export default function ProjectsDialog() {
  const currentId = useEditor((s) => s.project.id);
  const [list, setList] = useState<ProjectMeta[] | null>(null);
  const close = () => editor().set('dialog', null);
  const refresh = async () => {
    await flushSave();
    setList(await listProjects());
  };
  useEffect(() => {
    void refresh();
  }, []);

  return (
    <Modal
      title="Projects"
      wide
      onClose={close}
      footer={
        <>
          <button className="btn" onClick={() => openImportPicker({}, '.cutline', false)}>
            <Upload size={14} /> Open project file…
          </button>
          <div className="grow" />
          <button className="btn primary" onClick={() => editor().set('dialog', 'newProject')}>
            <Plus size={15} /> New project
          </button>
        </>
      }
    >
      <p className="subtle" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        Projects are saved automatically in this browser. To move a project to another computer, use “Save project file” from the project menu.
      </p>
      {list === null ? (
        <div className="row">
          <span className="spinner" /> Loading…
        </div>
      ) : (
        <div className="project-grid" role="list">
          {list.map((m) => (
            <ProjectCard
              key={m.id}
              meta={m}
              current={m.id === currentId}
              onOpen={async () => {
                if (m.id !== currentId) await openProjectById(m.id);
                close();
              }}
              onDuplicate={async () => {
                await duplicateProject(m.id);
                await refresh();
              }}
              onDelete={async () => {
                if (!window.confirm(`Delete “${m.name}”? This removes it from this browser and can’t be undone.`)) return;
                await deleteProject(m.id);
                await refresh();
              }}
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

function ProjectCard({ meta, current, onOpen, onDuplicate, onDelete }: { meta: ProjectMeta; current: boolean; onOpen: () => void; onDuplicate: () => void; onDelete: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!meta.thumbnail) return;
    const u = URL.createObjectURL(meta.thumbnail);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [meta.thumbnail]);
  const ar = meta.width / Math.max(1, meta.height);
  return (
    <div className={`project-card${current ? ' current' : ''}`} role="listitem">
      <button className="project-thumb" onClick={onOpen} aria-label={`Open ${meta.name}`}>
        {url ? <img src={url} alt="" style={{ aspectRatio: ar }} /> : <span className="project-thumb-empty" style={{ aspectRatio: ar }} />}
      </button>
      <div className="row" style={{ gap: 4 }}>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="ellipsis" style={{ fontWeight: 600 }}>
            {meta.name} {current && <span className="badge accent">Open</span>}
          </div>
          <div className="subtle" style={{ fontSize: 11.5 }}>
            {formatDuration(meta.duration)} · {meta.width}×{meta.height} · {new Date(meta.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </div>
        </div>
        <button
          className="icon-btn small"
          aria-label={`More options for ${meta.name}`}
          onClick={(e) =>
            openMenuBelow(
              e.currentTarget,
              [
                { label: 'Open', icon: <FolderOpen size={14} />, onClick: onOpen },
                { label: 'Duplicate', icon: <Copy size={14} />, onClick: onDuplicate },
                { kind: 'separator' },
                { label: 'Delete', icon: <Trash2 size={14} />, danger: true, onClick: onDelete },
              ],
              'right',
            )
          }
        >
          <MoreHorizontal size={15} />
        </button>
      </div>
    </div>
  );
}
