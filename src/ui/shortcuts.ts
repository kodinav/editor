import * as A from '@/state/actions';
import { editor, toast, usePlayback } from '@/state/store';
import { player } from '@/playback/player';
import { flushSave } from '@/state/projectManager';
import { zoomTimeline, zoomToFit } from './timeline/zoom';
import { openImportPicker } from './importPicker';

/**
 * Central keyboard shortcut registry. The same list drives the global key
 * handler, the shortcut help dialog and tooltip hints.
 */

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';
export const ALT = isMac ? '⌥' : 'Alt';
export const SHIFT = isMac ? '⇧' : 'Shift';

export interface Shortcut {
  id: string;
  group: 'Playback' | 'Editing' | 'Timeline' | 'Project';
  label: string;
  keys: string[];
  /** Key spec: "mod+shift+z", "space", "arrowleft", "?" */
  combos: string[];
  run: (e: KeyboardEvent) => void;
  /** Allow auto-repeat while the key is held. */
  repeat?: boolean;
}

const fmt = (combo: string) =>
  combo
    .split('+')
    .map((k) => {
      switch (k) {
        case 'mod':
          return MOD;
        case 'alt':
          return ALT;
        case 'shift':
          return SHIFT;
        case 'space':
          return 'Space';
        case 'arrowleft':
          return '←';
        case 'arrowright':
          return '→';
        case 'arrowup':
          return '↑';
        case 'arrowdown':
          return '↓';
        case 'backspace':
          return '⌫';
        case 'delete':
          return 'Del';
        case 'escape':
          return 'Esc';
        case 'plus':
          return '+';
        default:
          return k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1);
      }
    })
    .join(isMac ? '' : '+');

function sc(id: string, group: Shortcut['group'], label: string, combos: string[], run: Shortcut['run'], repeat = false): Shortcut {
  return { id, group, label, combos, keys: combos.map(fmt), run, repeat };
}

const fps = () => editor().project.settings.fps;
const now = () => usePlayback.getState().time;

export const SHORTCUTS: Shortcut[] = [
  sc('play', 'Playback', 'Play / pause', ['space'], () => player.toggle()),
  sc('playL', 'Playback', 'Play; press again for 2× and 4×', ['l'], () => player.shuttleForward()),
  sc('pauseK', 'Playback', 'Pause', ['k'], () => player.pause()),
  sc('backJ', 'Playback', 'Back 1 second', ['j'], () => player.seek(Math.max(0, now() - 1)), true),
  sc('frameBack', 'Playback', 'Previous frame', ['arrowleft'], () => player.step(-1), true),
  sc('frameFwd', 'Playback', 'Next frame', ['arrowright'], () => player.step(1), true),
  sc('secBack', 'Playback', 'Back 1 second', ['shift+arrowleft'], () => player.step(-Math.round(fps())), true),
  sc('secFwd', 'Playback', 'Forward 1 second', ['shift+arrowright'], () => player.step(Math.round(fps())), true),
  sc('prevEdit', 'Playback', 'Previous edit point', ['arrowup'], () => A.jumpToEdit(-1), true),
  sc('nextEdit', 'Playback', 'Next edit point', ['arrowdown'], () => A.jumpToEdit(1), true),
  sc('home', 'Playback', 'Go to start', ['home'], () => player.seek(0)),
  sc('end', 'Playback', 'Go to end', ['end'], () => player.seek(player.endTime())),
  sc('loop', 'Playback', 'Toggle loop', ['mod+l'], () => editor().set('loop', !editor().loop)),

  sc('split', 'Editing', 'Split at playhead', ['s', 'mod+b'], () => A.splitAtPlayhead()),
  sc('delete', 'Editing', 'Delete (ripples when Ripple is on)', ['delete', 'backspace'], () => A.deleteSelection()),
  sc('rippleDelete', 'Editing', 'Ripple delete', ['shift+delete', 'shift+backspace'], () => A.deleteSelection(true)),
  sc('undo', 'Editing', 'Undo', ['mod+z'], () => editor().undo(), true),
  sc('redo', 'Editing', 'Redo', ['mod+shift+z', 'mod+y'], () => editor().redo(), true),
  sc('copy', 'Editing', 'Copy', ['mod+c'], () => A.copySelection()),
  sc('cut', 'Editing', 'Cut', ['mod+x'], () => A.cutSelection()),
  sc('paste', 'Editing', 'Paste at playhead', ['mod+v'], () => A.paste()),
  sc('duplicate', 'Editing', 'Duplicate', ['mod+d'], () => A.duplicateSelection()),
  sc('selectAll', 'Editing', 'Select all clips', ['mod+a'], () => A.selectAll()),
  sc('deselect', 'Editing', 'Deselect / select tool', ['escape'], () => {
    if (editor().cropMode) {
      editor().set('cropMode', false);
      return;
    }
    editor().select([]);
    editor().set('tool', 'select');
  }),
  sc('trimStart', 'Editing', 'Trim start to playhead (ripple)', ['q'], () => A.trimToPlayhead('start')),
  sc('trimEnd', 'Editing', 'Trim end to playhead (ripple)', ['w'], () => A.trimToPlayhead('end')),
  sc('nudgeL', 'Editing', 'Nudge clip left 1 frame', ['alt+arrowleft'], () => A.nudgeSelection(-1), true),
  sc('nudgeR', 'Editing', 'Nudge clip right 1 frame', ['alt+arrowright'], () => A.nudgeSelection(1), true),
  sc('nudgeL10', 'Editing', 'Nudge clip left 10 frames', ['alt+shift+arrowleft'], () => A.nudgeSelection(-10), true),
  sc('nudgeR10', 'Editing', 'Nudge clip right 10 frames', ['alt+shift+arrowright'], () => A.nudgeSelection(10), true),
  sc('text', 'Editing', 'Add text', ['t'], () => void A.addTextPreset('title')),
  sc('freeze', 'Editing', 'Freeze frame', ['shift+f'], () => A.freezeFrame()),
  sc('detach', 'Editing', 'Detach audio', ['mod+shift+d'], () => A.detachAudioSelection()),
  sc('selectUnder', 'Editing', 'Select clip at playhead (press again for the clip below)', ['d'], () => A.selectClipAtPlayhead()),
  sc('selectPrev', 'Editing', 'Select previous clip on the track', ['['], () => A.selectSiblingClip(-1)),
  sc('selectNext', 'Editing', 'Select next clip on the track', [']'], () => A.selectSiblingClip(1)),
  sc('selectUp', 'Editing', 'Select clip on the track above', ['alt+arrowup'], () => A.selectClipOnAdjacentTrack(-1)),
  sc('selectDown', 'Editing', 'Select clip on the track below', ['alt+arrowdown'], () => A.selectClipOnAdjacentTrack(1)),

  sc('toolSelect', 'Timeline', 'Selection tool', ['v'], () => editor().set('tool', 'select')),
  sc('toolRazor', 'Timeline', 'Blade tool', ['c', 'b'], () => editor().set('tool', 'razor')),
  sc('snap', 'Timeline', 'Toggle snapping', ['n'], () => {
    editor().set('snapping', !editor().snapping);
    toast({ kind: 'info', message: `Snapping ${editor().snapping ? 'on' : 'off'}`, timeout: 1200 });
  }),
  sc('ripple', 'Timeline', 'Toggle ripple editing', ['r'], () => {
    editor().set('ripple', !editor().ripple);
    toast({ kind: 'info', message: `Ripple editing ${editor().ripple ? 'on' : 'off'}`, timeout: 1200 });
  }),
  sc('marker', 'Timeline', 'Add marker', ['m'], () => A.addMarker()),
  sc('in', 'Timeline', 'Set in point', ['i'], () => A.setInPoint()),
  sc('out', 'Timeline', 'Set out point', ['o'], () => A.setOutPoint()),
  sc('clearInOut', 'Timeline', 'Clear in/out', ['alt+x'], () => {
    A.setInPoint(null);
    A.setOutPoint(null);
  }),
  sc('zoomIn', 'Timeline', 'Zoom in', ['=', 'plus'], () => zoomTimeline(1.25), true),
  sc('zoomOut', 'Timeline', 'Zoom out', ['-', '_'], () => zoomTimeline(0.8), true),
  sc('zoomFit', 'Timeline', 'Zoom to fit', ['\\', 'shift+z'], () => zoomToFit()),

  sc('import', 'Project', 'Import media', ['mod+i'], () => openImportPicker()),
  sc('export', 'Project', 'Export video', ['mod+e'], () => editor().set('dialog', 'export')),
  sc('save', 'Project', 'Save now', ['mod+s'], () =>
    void flushSave().then(() => {
      // Report what actually happened (writeNow shows its own error toast on failure).
      const s = editor();
      if (s.readOnlyReason) toast({ kind: 'warning', message: 'Not saved: this project is open for editing in another tab.' });
      else if (s.saveState === 'saved') toast({ kind: 'success', message: 'Saved locally.', timeout: 1200 });
    }),
  ),
  sc('help', 'Project', 'Keyboard shortcuts', ['shift+?', '?', 'shift+/'], () => editor().set('dialog', 'shortcuts')),
];

/**
 * Candidate combo strings for a key event. Symbol keys produced with Shift
 * (e.g. "?" or "+") are matched both with and without the shift modifier,
 * since keyboard layouts differ in how they report them.
 */
function combosOf(e: KeyboardEvent): string[] {
  const mods: string[] = [];
  if (isMac ? e.metaKey : e.ctrlKey) mods.push('mod');
  if (e.altKey) mods.push('alt');
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === '+') key = 'plus';
  // With Alt on macOS, e.key is a special character; fall back to the physical key.
  if (e.altKey && e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase();
  if (e.altKey && e.code.startsWith('Digit')) key = e.code.slice(5);
  const withShift = e.shiftKey ? [...mods, 'shift', key].join('+') : null;
  const plain = [...mods, key].join('+');
  const isSymbol = key.length === 1 && !/[a-z0-9]/.test(key);
  if (!e.shiftKey) return [plain];
  // Letters/named keys require the shift modifier; symbols may be reported either way.
  return isSymbol ? [withShift!, plain] : [withShift!];
}

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'range', 'button', 'color'].includes(type);
  }
  return false;
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (isTypingTarget(e.target)) return;
    // Open dialogs handle their own keys (Escape closes them natively).
    if (document.querySelector('dialog[open]')) return;
    if (document.querySelector('.menu')) return;
    const combos = combosOf(e);
    const target = e.target as HTMLElement;
    // Space/Enter on a focused button should activate the button, not play.
    if ((combos[0] === 'space' || combos[0] === 'enter') && target.tagName === 'BUTTON') return;
    for (const s of SHORTCUTS) {
      if (combos.some((c) => s.combos.includes(c))) {
        if (e.repeat && !s.repeat) {
          e.preventDefault();
          return;
        }
        e.preventDefault();
        s.run(e);
        return;
      }
    }
  };
  // A button or dropdown used with the mouse shouldn't keep focus: otherwise Space presses it
  // again instead of playing, and arrow keys change the dropdown. Keyboard users keep focus.
  let lastPointer = 0;
  const onPointer = () => (lastPointer = performance.now());
  const onClick = (e: MouseEvent) => {
    const el = (e.target as HTMLElement | null)?.closest('button, [role="tab"]') as HTMLElement | null;
    if (el && e.detail > 0 && !el.closest('dialog, .menu')) el.blur();
  };
  const onChange = (e: Event) => {
    const el = e.target as HTMLElement;
    if (el.tagName === 'SELECT' && performance.now() - lastPointer < 2000 && !el.closest('dialog')) el.blur();
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointerdown', onPointer, true);
  window.addEventListener('click', onClick);
  window.addEventListener('change', onChange);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('pointerdown', onPointer, true);
    window.removeEventListener('click', onClick);
    window.removeEventListener('change', onChange);
  };
}

export function shortcutHint(id: string): string | undefined {
  return SHORTCUTS.find((s) => s.id === id)?.keys[0];
}
