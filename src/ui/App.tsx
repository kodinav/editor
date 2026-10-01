import { useEffect, useState, lazy, Suspense, type ReactNode } from 'react';
import { Download, Film, LayoutGrid, Sparkles, Type, SlidersHorizontal, Upload } from 'lucide-react';
import { useEditor } from '@/state/store';
import { importFiles } from '@/state/importer';
import { stealLock } from '@/state/projectManager';
import { MenuLayer } from './common/Menu';
import { TooltipLayer } from './common/Tooltip';
import { Toasts } from './common/Toasts';
import { installShortcuts } from './shortcuts';
import { TopBar } from './TopBar';
import { LeftDock } from './panels/LeftDock';
import { PreviewPane } from './preview/PreviewPane';
import { Inspector } from './inspector/Inspector';
import { Timeline } from './timeline/Timeline';
import { useLocalNumber, useMediaQuery } from './hooks';
import { Splitter } from './Splitter';
import { ErrorBoundary } from './ErrorBoundary';
import { Announcer } from './Announcer';

const ExportDialog = lazy(() => import('./dialogs/ExportDialog'));
const ProjectsDialog = lazy(() => import('./dialogs/ProjectsDialog'));
const ShortcutsDialog = lazy(() => import('./dialogs/ShortcutsDialog'));
const SettingsDialog = lazy(() => import('./dialogs/SettingsDialog'));

type Layout = 'desktop' | 'tablet' | 'phone';

export function App() {
  const isPhone = useMediaQuery('(max-width: 760px), (max-height: 520px) and (max-width: 950px)');
  const isTablet = useMediaQuery('(max-width: 1180px)');
  const layout: Layout = isPhone ? 'phone' : isTablet ? 'tablet' : 'desktop';
  const dialog = useEditor((s) => s.dialog);
  const readOnly = useEditor((s) => s.readOnlyReason);
  const [dragging, setDragging] = useState(false);

  useEffect(() => installShortcuts(), []);

  // Whole-window drop target for importing files.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      // Drops on the timeline are handled there (they carry a position).
      if ((e.target as HTMLElement).closest?.('[data-drop-zone="timeline"]')) return;
      const files = [...(e.dataTransfer?.files ?? [])];
      if (files.length) void importFiles(files);
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return (
    <div className="app" data-layout={layout}>
      <a href="#timeline" className="sr-only">
        Skip to timeline
      </a>
      <TopBar layout={layout} />
      {readOnly && (
        <div className="readonly-banner" role="status">
          <span className="grow">{readOnly}</span>
          <button className="btn small" onClick={() => void stealLock()}>
            Edit here instead
          </button>
        </div>
      )}
      {layout === 'phone' ? <PhoneWorkspace /> : <DesktopWorkspace layout={layout} />}
      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="inner">
            <Upload size={36} />
            Drop files to import
            <span className="muted" style={{ fontWeight: 400, fontSize: 13 }}>
              Video, audio, images, fonts, SRT/VTT captions, or a .cutline project
            </span>
          </div>
        </div>
      )}
      <Suspense fallback={null}>
        {dialog === 'export' && <ExportDialog />}
        {dialog === 'projects' && <ProjectsDialog />}
        {dialog === 'shortcuts' && <ShortcutsDialog />}
        {(dialog === 'settings' || dialog === 'newProject') && <SettingsDialog mode={dialog === 'newProject' ? 'new' : 'edit'} />}
      </Suspense>
      <Announcer />
      <MenuLayer />
      <TooltipLayer />
      <Toasts />
    </div>
  );
}

function DesktopWorkspace({ layout }: { layout: Layout }) {
  const [leftW, setLeftW] = useLocalNumber('layout.leftW', 320);
  const [rightW, setRightW] = useLocalNumber('layout.rightW', 316);
  const [upperFrac, setUpperFrac] = useLocalNumber('layout.upperFrac', 0.56);
  const leftOpen = useEditor((s) => s.leftOpen);
  const inspectorOpen = useEditor((s) => s.inspectorOpen);
  const [wsH, setWsH] = useState(() => window.innerHeight - 48);

  useEffect(() => {
    const on = () => setWsH(window.innerHeight - 48);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  const upperH = Math.round(Math.min(wsH - 150, Math.max(180, wsH * upperFrac)));
  const showInspector = layout === 'desktop' || inspectorOpen;

  return (
    <div className="workspace">
      <div className="upper" style={{ height: upperH }}>
        <ErrorBoundary name="library">
          <LeftDock width={leftOpen ? leftW : 64} panelOpen={leftOpen} />
        </ErrorBoundary>
        {leftOpen && <Splitter dir="v" value={leftW} min={240} max={560} onChange={setLeftW} label="Resize media panel" />}
        <div className="center">
          <ErrorBoundary name="preview">
            <PreviewPane />
          </ErrorBoundary>
        </div>
        {showInspector && layout === 'desktop' && <Splitter dir="v" value={rightW} min={260} max={520} invert onChange={setRightW} label="Resize inspector" />}
        {showInspector && (
          <div className="right-dock" style={{ width: rightW }}>
            <ErrorBoundary name="inspector">
              <Inspector />
            </ErrorBoundary>
          </div>
        )}
      </div>
      <Splitter dir="h" value={upperH} min={180} max={wsH - 150} onChange={(v) => setUpperFrac(v / wsH)} label="Resize timeline" />
      <div className="lower" id="timeline">
        <ErrorBoundary name="timeline">
          <Timeline />
        </ErrorBoundary>
      </div>
    </div>
  );
}

type PhoneTab = 'media' | 'text' | 'effects' | 'edit' | null;

function PhoneWorkspace() {
  const [tab, setTab] = useState<PhoneTab>(null);
  const set = useEditor((s) => s.set);
  const selection = useEditor((s) => s.selection);
  const sheet = (content: ReactNode) => (
    <>
      <div className="sheet-backdrop" onClick={() => setTab(null)} />
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet-grip" />
        {content}
      </div>
    </>
  );
  const open = (t: Exclude<PhoneTab, null>) => {
    if (t === 'media') set('leftPanel', 'media');
    if (t === 'text') set('leftPanel', 'text');
    if (t === 'effects') set('leftPanel', 'effects');
    setTab(tab === t ? null : t);
  };
  return (
    <div className="workspace">
      <div style={{ height: '40%', minHeight: 180, display: 'flex', flexDirection: 'column' }}>
        <PreviewPane compact />
      </div>
      <div className="lower" id="timeline">
        <Timeline compact />
      </div>
      <nav className="phone-nav" aria-label="Editor tools">
        <button aria-pressed={tab === 'media'} onClick={() => open('media')}>
          <Film size={18} />
          Media
        </button>
        <button aria-pressed={tab === 'text'} onClick={() => open('text')}>
          <Type size={18} />
          Text
        </button>
        <button aria-pressed={tab === 'effects'} onClick={() => open('effects')}>
          <Sparkles size={18} />
          Effects
        </button>
        <button aria-pressed={tab === 'edit'} onClick={() => open('edit')} disabled={selection.length === 0 && tab !== 'edit'}>
          <SlidersHorizontal size={18} />
          Edit
        </button>
        <button onClick={() => set('dialog', 'projects')}>
          <LayoutGrid size={18} />
          Projects
        </button>
        <button onClick={() => set('dialog', 'export')}>
          <Download size={18} />
          Export
        </button>
      </nav>
      {tab && tab !== 'edit' && sheet(<LeftDock width={0} panelOpen sheet />)}
      {tab === 'edit' && sheet(<Inspector />)}
    </div>
  );
}
