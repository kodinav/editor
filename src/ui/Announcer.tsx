import { useEffect, useState } from 'react';
import { formatDuration } from '@/core/time';
import { useEditor } from '@/state/store';

/**
 * Polite screen-reader announcements for state changes that are otherwise only
 * visible on the canvas or timeline (selection, undo/redo).
 */
export function Announcer() {
  const [msg, setMsg] = useState('');
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (s.selection !== prev.selection && s.selection.length) {
          if (s.selection.length > 1) setMsg(`${s.selection.length} clips selected`);
          else {
            const c = s.project.clips[s.selection[0]];
            if (c) setMsg(`Selected ${c.type} clip ${c.name}, from ${formatDuration(c.start)} for ${formatDuration(c.duration)}`);
          }
        } else if (s.past.length < prev.past.length && s.future.length > prev.future.length) {
          setMsg(`Undid ${s.future[0]?.label ?? 'change'}`);
        } else if (prev.future.length > 0 && s.project.clips === prev.future[0].project.clips && s.future.length === prev.future.length - 1) {
          // Redo restores the next snapshot (same clips object), unlike a fresh edit.
          setMsg(`Redid ${s.lastLabel}`);
        }
      }),
    [],
  );
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {msg}
    </div>
  );
}
