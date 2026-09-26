import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useUiStore } from '@/store/uiStore';
import { cx } from './index';

const ICONS = {
  success: <CheckCircle2 className="h-4 w-4 text-ok" />,
  error: <XCircle className="h-4 w-4 text-danger" />,
  warning: <AlertTriangle className="h-4 w-4 text-warn" />,
  info: <Info className="h-4 w-4 text-info" />,
};

export function Toasts() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('panel flex items-start gap-2 p-3 shadow-lg', t.kind === 'error' && 'border-danger/50')} role={t.kind === 'error' ? 'alert' : 'status'}>
          <div className="mt-0.5 shrink-0">{ICONS[t.kind]}</div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t.title}</div>
            {t.message && <div className="text-xs text-muted mt-0.5 break-words">{t.message}</div>}
          </div>
          <button type="button" className="btn-icon btn-ghost -m-1" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ConfirmHost() {
  const confirm = useUiStore((s) => s.confirm);
  const resolve = useUiStore((s) => s.resolveConfirm);
  if (!confirm) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && resolve(false)}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" className="panel w-full max-w-md" onKeyDown={(e) => e.key === 'Escape' && resolve(false)}>
        <div className="p-4">
          <h2 id="confirm-title" className="text-sm font-semibold">
            {confirm.title}
          </h2>
          <p className="mt-2 text-xs text-muted leading-5 whitespace-pre-line">{confirm.message}</p>
        </div>
        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-line">
          <button type="button" className="btn-secondary" onClick={() => resolve(false)} autoFocus>
            {confirm.cancelLabel ?? 'Cancel'}
          </button>
          <button type="button" className={confirm.danger ? 'btn-danger' : 'btn-primary'} onClick={() => resolve(true)}>
            {confirm.confirmLabel ?? 'Confirm'}
          </button>
        </footer>
      </div>
    </div>
  );
}
