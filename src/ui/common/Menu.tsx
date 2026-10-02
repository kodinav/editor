import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

/**
 * Accessible popup menus (dropdowns and context menus) rendered in a portal.
 * Arrow keys move focus, Enter/Space activate, Escape or outside click closes.
 */

export type MenuItem =
  | { kind?: 'item'; label: string; icon?: ReactNode; kbd?: string; onClick: () => void; disabled?: boolean; danger?: boolean; checked?: boolean }
  | { kind: 'separator' }
  | { kind: 'label'; label: string };

interface MenuState {
  open: { x: number; y: number; items: MenuItem[]; anchor?: HTMLElement | null; id: number; alignRight?: boolean } | null;
  show(x: number, y: number, items: MenuItem[], anchor?: HTMLElement | null, alignRight?: boolean): void;
  close(): void;
}

let seq = 0;
/** Where focus goes back to when a menu closes (the button that opened it, or what had focus). */
let returnFocus: HTMLElement | null = null;
export const useMenuStore = create<MenuState>()((set) => ({
  open: null,
  show: (x, y, items, anchor, alignRight) => {
    returnFocus = anchor ?? (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null);
    set({ open: { x, y, items, anchor, id: ++seq, alignRight } });
  },
  close: () => set({ open: null }),
}));

/** After a menu action: unless the action moved focus somewhere on purpose (a dialog, a field), go back. */
function restoreFocus() {
  const el = returnFocus;
  returnFocus = null;
  setTimeout(() => {
    if (el?.isConnected && (document.activeElement === document.body || document.activeElement === null)) el.focus({ preventScroll: true });
  });
}

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: MenuItem[]) {
  e.preventDefault();
  useMenuStore.getState().show(e.clientX, e.clientY, items);
}

export function openMenuBelow(anchor: HTMLElement, items: MenuItem[], align: 'left' | 'right' = 'left') {
  const r = anchor.getBoundingClientRect();
  useMenuStore.getState().show(align === 'left' ? r.left : r.right, r.bottom + 4, items, anchor, align === 'right');
}

export function MenuLayer() {
  const open = useMenuStore((s) => s.open);
  const close = useMenuStore((s) => s.close);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !ref.current) {
      setPos(null);
      return;
    }
    const el = ref.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = open.alignRight ? open.x - w : open.x;
    let top = open.y;
    if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, open.y - h - (open.anchor ? open.anchor.getBoundingClientRect().height + 8 : 0));
    setPos({ left: Math.max(8, left), top: Math.max(8, top) });
    const first = el.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(open.anchor && open.anchor.contains(e.target as Node))) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
        open.anchor?.focus();
      }
    };
    const onBlur = () => close();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [open, close]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close();
    }
  };

  return createPortal(
    <div
      key={open.id}
      ref={ref}
      className="menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos?.left ?? open.x, top: pos?.top ?? open.y, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {open.items.map((item, i) => {
        if (item.kind === 'separator') return <div key={i} className="menu-sep" role="separator" />;
        if (item.kind === 'label') return <div key={i} className="menu-label">{item.label}</div>;
        return (
          <button
            key={i}
            role={item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={item.checked}
            className={`menu-item${item.danger ? ' danger' : ''}`}
            disabled={item.disabled}
            onClick={(e) => {
              close();
              item.onClick();
              // Keyboard users continue where they were; mouse users don't need focus anywhere.
              if (e.detail === 0) restoreFocus();
              else returnFocus = null;
            }}
          >
            <span style={{ width: 16, display: 'inline-flex', justifyContent: 'center', flexShrink: 0 }}>
              {item.checked ? '✓' : item.icon}
            </span>
            <span className="grow ellipsis">{item.label}</span>
            {item.kbd && <span className="kbd">{item.kbd}</span>}
          </button>
        );
      })}
    </div>,
    // Inside an open modal <dialog> everything else is inert: the menu has to live in the dialog.
    [...document.querySelectorAll('dialog[open]')].pop() ?? document.body,
  );
}
