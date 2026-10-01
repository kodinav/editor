import { editor } from '@/state/store';
import { Modal } from '../common/Modal';
import { SHORTCUTS, type Shortcut } from '../shortcuts';

export default function ShortcutsDialog() {
  const groups = new Map<Shortcut['group'], Shortcut[]>();
  for (const s of SHORTCUTS) {
    const arr = groups.get(s.group) ?? [];
    arr.push(s);
    groups.set(s.group, arr);
  }
  return (
    <Modal title="Keyboard shortcuts" wide onClose={() => editor().set('dialog', null)}>
      <div className="shortcut-cols">
        {[...groups.entries()].map(([g, list]) => (
          <section key={g}>
            <h3 className="panel-subhead">{g}</h3>
            <dl className="shortcut-list">
              {list.map((s) => (
                <div key={s.id} className="shortcut-row">
                  <dt>{s.label}</dt>
                  <dd>
                    {s.keys.slice(0, 2).map((k, i) => (
                      <span key={k}>
                        {i > 0 && <span className="subtle"> or </span>}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <p className="subtle" style={{ fontSize: 12, marginBottom: 0 }}>
        Mouse: drag clip edges to trim, drag clips between tracks to move, hold ⌥/Alt while dragging to duplicate, hold ⇧ Shift to toggle snapping, ⌘/Ctrl + scroll to zoom the timeline.
      </p>
    </Modal>
  );
}
