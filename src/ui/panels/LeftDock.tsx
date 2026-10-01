import { Blend, Captions, Film, Palette, PanelLeftClose, PanelLeftOpen, Shapes, Sparkles, Type } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEditor, type LeftPanel } from '@/state/store';
import { MediaPanel } from './MediaPanel';
import { TextPanel, ElementsPanel, TransitionsPanel, EffectsPanel, FiltersPanel } from './LibraryPanels';
import { CaptionsPanel } from './CaptionsPanel';

const TABS: { id: LeftPanel; label: string; icon: ReactNode }[] = [
  { id: 'media', label: 'Media', icon: <Film size={19} /> },
  { id: 'text', label: 'Text', icon: <Type size={19} /> },
  { id: 'elements', label: 'Elements', icon: <Shapes size={19} /> },
  { id: 'transitions', label: 'Transitions', icon: <Blend size={19} /> },
  { id: 'effects', label: 'Effects', icon: <Sparkles size={19} /> },
  { id: 'filters', label: 'Filters', icon: <Palette size={19} /> },
  { id: 'captions', label: 'Captions', icon: <Captions size={19} /> },
];

export function LeftDock({ width, panelOpen, sheet }: { width: number; panelOpen: boolean; sheet?: boolean }) {
  const active = useEditor((s) => s.leftPanel);
  const set = useEditor((s) => s.set);
  const leftOpen = useEditor((s) => s.leftOpen);

  const panel = (() => {
    switch (active) {
      case 'media':
        return <MediaPanel />;
      case 'text':
        return <TextPanel />;
      case 'elements':
        return <ElementsPanel />;
      case 'transitions':
        return <TransitionsPanel />;
      case 'effects':
        return <EffectsPanel />;
      case 'filters':
        return <FiltersPanel />;
      case 'captions':
        return <CaptionsPanel />;
    }
  })();

  if (sheet) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
        <div className="segmented" style={{ margin: '6px 10px' }} role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={active === t.id} aria-pressed={active === t.id} onClick={() => set('leftPanel', t.id)} aria-label={t.label}>
              {t.icon}
            </button>
          ))}
        </div>
        <div className="panel" style={{ minHeight: 0 }}>
          {panel}
        </div>
      </div>
    );
  }

  return (
    <div className="left-dock" style={{ width }}>
      <div className="rail" role="tablist" aria-label="Library" aria-orientation="vertical">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            className="rail-btn"
            aria-selected={active === t.id && panelOpen}
            aria-controls="left-panel"
            onClick={() => {
              if (active === t.id && leftOpen) set('leftOpen', false);
              else {
                set('leftPanel', t.id);
                set('leftOpen', true);
              }
            }}
            onKeyDown={(e) => {
              const i = TABS.findIndex((x) => x.id === active);
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next = TABS[(i + (e.key === 'ArrowDown' ? 1 : TABS.length - 1)) % TABS.length];
                set('leftPanel', next.id);
                set('leftOpen', true);
                (e.currentTarget.parentElement?.children[TABS.indexOf(next)] as HTMLElement | undefined)?.focus();
              }
            }}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
        <div className="grow" />
        <button className="rail-btn" aria-label={leftOpen ? 'Collapse panel' : 'Expand panel'} data-tip={leftOpen ? 'Collapse panel' : 'Expand panel'} onClick={() => set('leftOpen', !leftOpen)}>
          {leftOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
        </button>
      </div>
      {panelOpen && (
        <div className="panel" id="left-panel" role="tabpanel">
          {panel}
        </div>
      )}
    </div>
  );
}

export function PanelHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="panel-head">
      <h2>{title}</h2>
      {children}
    </div>
  );
}
