import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject, createTextClip } from '../../src/core/project';
import { useEditor } from '../../src/state/store';
import type { Asset } from '../../src/core/types';

const s = () => useEditor.getState();

function fresh() {
  const p = createProject('t');
  const track = p.tracks.find((t) => t.kind === 'video')!;
  const clip = createTextClip({ trackId: track.id, start: 0, duration: 2 }, 'a');
  p.clips[clip.id] = clip;
  s().loadProject(p);
  return clip.id;
}

const text = (id: string) => (s().project.clips[id] as { text: string }).text;
const x = (id: string) => (s().project.clips[id] as { transform: { x: number } }).transform.x;

describe('editor history', () => {
  let now = 1_000_000;
  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a burst of typing is one undo step; a pause starts a new one', () => {
    const id = fresh();
    for (const v of ['ab', 'abc', 'abcd']) {
      now += 200;
      s().commit('Edit text', (d) => void ((d.clips[id] as { text: string }).text = v), { coalesce: `text:${id}` });
    }
    expect(s().past).toHaveLength(1);
    now += 5000; // pause
    s().commit('Edit text', (d) => void ((d.clips[id] as { text: string }).text = 'abcde'), { coalesce: `text:${id}` });
    expect(s().past).toHaveLength(2);
    s().undo();
    expect(text(id)).toBe('abcd');
    s().undo();
    expect(text(id)).toBe('a');
  });

  it('a different edit in between ends the burst', () => {
    const id = fresh();
    s().commit('Edit text', (d) => void ((d.clips[id] as { text: string }).text = 'ab'), { coalesce: `text:${id}` });
    s().commit('Add marker', (d) => void d.markers.push({ id: 'm', t: 1, label: 'M', color: '#fff' }));
    s().commit('Edit text', (d) => void ((d.clips[id] as { text: string }).text = 'abc'), { coalesce: `text:${id}` });
    expect(s().past).toHaveLength(3);
  });

  it('an edit that lands mid-gesture is kept, as its own undo step', () => {
    const id = fresh();
    s().beginGesture('Move');
    s().updateGesture((d) => void ((d.clips[id] as { transform: { x: number } }).transform.x = 50));
    // e.g. a background job finishing while the user is still dragging
    s().commit('Add marker', (d) => void d.markers.push({ id: 'm', t: 1, label: 'M', color: '#fff' }));
    expect(s().project.markers).toHaveLength(1);
    expect(x(id)).toBe(50);
    s().updateGesture((d) => void ((d.clips[id] as { transform: { x: number } }).transform.x = 80));
    expect(s().project.markers).toHaveLength(1); // not dropped by the next drag update
    s().endGesture();
    expect(x(id)).toBe(80);
    s().undo(); // the move
    expect(x(id)).toBe(0);
    expect(s().project.markers).toHaveLength(1);
    s().undo(); // the marker
    expect(s().project.markers).toHaveLength(0);
  });

  it('a gesture left open (lost pointer) does not disable undo or swallow the next gesture', () => {
    const id = fresh();
    s().beginGesture('Scale');
    s().updateGesture((d) => void ((d.clips[id] as { transform: { x: number } }).transform.x = 10));
    expect(s().saveState).toBe('unsaved'); // and autosave sees it
    s().beginGesture('Move'); // next drag starts: the stranded one is closed first
    s().updateGesture((d) => void ((d.clips[id] as { transform: { x: number } }).transform.x = 20));
    s().endGesture();
    expect(s().past.map((e) => e.label)).toEqual(['Scale', 'Move']);
    s().beginGesture('Rotate');
    s().updateGesture((d) => void ((d.clips[id] as { transform: { x: number } }).transform.x = 30));
    s().undo(); // works even though 'Rotate' never ended
    expect(s().gestureBase).toBeNull();
    expect(x(id)).toBe(20);
  });

  it('removing media is undoable and redoable, and imports survive undo', () => {
    fresh();
    const asset = { id: 'a1', kind: 'image', name: 'logo.png', mimeType: 'image/png', size: 1, lastModified: 0, duration: 0, status: 'ready', stored: true, createdAt: 0, image: { width: 10, height: 10 } } as Asset;
    s().commit('Marker', (d) => void d.markers.push({ id: 'm', t: 1, label: 'M', color: '#fff' }));
    s().silent((d) => void (d.assets.a1 = asset)); // import
    s().undo(); // undoing the marker keeps the import
    expect(s().project.assets.a1).toBeTruthy();
    s().redo();
    s().commit('Remove media', (d) => void delete d.assets.a1);
    expect(s().project.assets.a1).toBeUndefined();
    s().undo();
    expect(s().project.assets.a1).toBeTruthy();
    s().silent((d) => void (d.assets.a1.stored = false)); // metadata update while restored
    s().redo();
    expect(s().project.assets.a1).toBeUndefined();
    s().undo();
    expect(s().project.assets.a1?.stored).toBe(false); // newer metadata is never rolled back
  });
});

describe('track lock', () => {
  it('no edit can change clips on a locked track, from any path', () => {
    const id = fresh();
    const trackId = s().project.clips[id].trackId;
    s().commit('Lock', (d) => void (d.tracks.find((t) => t.id === trackId)!.locked = true));
    const before = s().project.clips[id];
    s().commit('Edit text', (d) => void ((d.clips[id] as { text: string }).text = 'changed'));
    s().commit('Delete', (d) => void delete d.clips[id]);
    s().beginGesture('Opacity');
    s().updateGesture((d) => void ((d.clips[id] as { transform: { opacity: number } }).transform.opacity = 0.2));
    s().endGesture();
    expect(s().project.clips[id]).toBe(before);
    s().commit('Unlock', (d) => void (d.tracks.find((t) => t.id === trackId)!.locked = false));
    s().commit('Edit text', (d) => void ((d.clips[id] as { text: string }).text = 'changed'));
    expect(text(id)).toBe('changed');
  });
});
