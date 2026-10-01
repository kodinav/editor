import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Modal built on the native <dialog> element: focus trapping, Escape to close,
 * an inert background, and correct screen-reader semantics come for free.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  dismissable = true,
  labelledBy,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  dismissable?: boolean;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = labelledBy ?? 'modal-title';

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (!d.open) d.showModal();
    return () => {
      if (d.open) d.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? ' wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissable) onClose();
      }}
      onPointerDown={(e) => {
        // Click on the backdrop (the dialog element itself, outside its content) closes.
        if (dismissable && e.target === ref.current) {
          const r = ref.current.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
        }
      }}
    >
      <div className="modal-inner">
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {dismissable && (
            <button className="icon-btn small" aria-label="Close" onClick={onClose}>
              <X size={16} />
            </button>
          )}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </dialog>
  );
}
