import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useEditor } from '@/state/store';

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  const dismiss = useEditor((s) => s.dismissToast);
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <span style={{ marginTop: 1, flexShrink: 0 }}>
            {t.kind === 'success' ? (
              <CheckCircle2 size={16} color="var(--success)" />
            ) : t.kind === 'warning' ? (
              <AlertTriangle size={16} color="var(--warning)" />
            ) : t.kind === 'error' ? (
              <XCircle size={16} color="var(--danger)" />
            ) : (
              <Info size={16} color="var(--accent-text)" />
            )}
          </span>
          <div className="grow">
            <div className="msg">{t.message}</div>
            {t.detail && <div className="detail">{t.detail}</div>}
            {t.action && (
              <button
                className="btn small"
                style={{ marginTop: 8 }}
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button className="icon-btn tiny" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
