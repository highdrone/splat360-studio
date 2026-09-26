/* Small shared UI primitives. Kept in one module to keep imports short. */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, Loader2, AlertTriangle, Inbox, RefreshCw, X } from 'lucide-react';
import { copyText } from '@/lib/desktop';
import type { JobStatus, ProjectStatus, StageStatus } from '@/api/types';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function Spinner({ className = '' }: { className?: string }) {
  return <Loader2 className={cx('animate-spin', className || 'h-4 w-4')} aria-label="Loading" />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-muted py-6 justify-center" role="status">
      <Spinner /> <span>{label}</span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4 gap-2">
      <div className="text-faint">{icon ?? <Inbox className="h-8 w-8" />}</div>
      <div className="text-sm font-medium text-ink">{title}</div>
      {children && <div className="text-xs text-muted max-w-md leading-5">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
}: {
  title?: string;
  message?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-sm flex gap-3 items-start" role="alert">
      <AlertTriangle className="h-4 w-4 text-danger mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-ink">{title}</div>
        {message && <div className="text-xs text-muted mt-0.5 break-words">{message}</div>}
      </div>
      {onRetry && (
        <button type="button" className="btn-secondary btn-sm" onClick={onRetry}>
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      )}
    </div>
  );
}

export function Note({ kind = 'info', children }: { kind?: 'info' | 'warning' | 'error' | 'success'; children: ReactNode }) {
  const styles = {
    info: 'border-info/40 bg-info/10 text-ink',
    warning: 'border-warn/50 bg-warn/10 text-ink',
    error: 'border-danger/40 bg-danger/10 text-ink',
    success: 'border-ok/40 bg-ok/10 text-ink',
  }[kind];
  return <div className={cx('rounded-md border px-3 py-2 text-xs leading-5', styles)}>{children}</div>;
}

export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cx('btn-ghost btn-sm', className)}
      title={label}
      aria-label={label}
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
      {label !== 'Copy' && <span>{done ? 'Copied' : label}</span>}
    </button>
  );
}

export function PathChip({ path }: { path: string }) {
  return (
    <span className="inline-flex items-center gap-1 max-w-full min-w-0">
      <code className="code truncate" title={path}>
        {path}
      </code>
      <CopyButton text={path} />
    </span>
  );
}

type AnyStatus = ProjectStatus | JobStatus | StageStatus | 'ready' | 'draft';

const STATUS_STYLES: Record<AnyStatus, string> = {
  draft: 'bg-panel2 text-muted border-line',
  ready: 'bg-info/15 text-info border-info/30',
  queued: 'bg-info/15 text-info border-info/30',
  pending: 'bg-panel2 text-muted border-line',
  running: 'bg-accent/15 text-accent border-accent/30',
  complete: 'bg-ok/15 text-ok border-ok/30',
  failed: 'bg-danger/15 text-danger border-danger/30',
  cancelled: 'bg-warn/15 text-warn border-warn/30',
  skipped: 'bg-panel2 text-faint border-line',
};

export function StatusPill({ status, className = '' }: { status: AnyStatus; className?: string }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide',
        STATUS_STYLES[status] ?? STATUS_STYLES.pending,
        className,
      )}
    >
      {status === 'running' && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />}
      {status}
    </span>
  );
}

export function ProgressBar({ value, indeterminate = false, className = '' }: { value: number; indeterminate?: boolean; className?: string }) {
  const pct = Math.max(0, Math.min(100, value * 100));
  return (
    <div className={cx('progress', indeterminate && 'progress-indeterminate', className)} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
}) {
  const autoId = useId();
  const switchId = id ?? autoId;
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        id={switchId}
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={cx('switch', disabled && 'opacity-50 cursor-not-allowed')}
        onClick={() => !disabled && onChange(!checked)}
      >
        <span className="switch-knob" />
      </button>
      {label && (
        <label htmlFor={switchId} className="text-[13px] text-ink cursor-pointer">
          {label}
        </label>
      )}
    </span>
  );
}

export function Field({
  label,
  help,
  error,
  children,
  htmlFor,
  className = '',
}: {
  label: string;
  help?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <div className={cx('min-w-0', className)}>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <div className="text-2xs text-danger mt-1">{error}</div> : help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function Panel({ title, actions, children, className = '', bodyClassName = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cx('panel', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 px-3 py-2 border-b border-line">
          <h3 className="panel-title">{title}</h3>
          {actions && <div className="flex items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cx('p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-2xs uppercase tracking-wide text-muted">{label}</div>
      <div className="text-sm font-semibold text-ink truncate">{value}</div>
      {hint && <div className="text-2xs text-faint truncate">{hint}</div>}
    </div>
  );
}

export function KeyValue({ items }: { items: { k: string; v: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
      {items.map(({ k, v }) => (
        <div key={k} className="contents">
          <dt className="text-muted whitespace-nowrap">{k}</dt>
          <dd className="text-ink min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const first = ref.current?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]');
    first?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={cx('panel w-full', wide ? 'max-w-3xl' : 'max-w-md')}>
        <header className="flex items-center justify-between px-4 py-3 border-b border-line">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" className="btn-icon btn-ghost" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4 text-sm">{children}</div>
        {footer && <footer className="flex justify-end gap-2 px-4 py-3 border-t border-line">{footer}</footer>}
      </div>
    </div>
  );
}

export function Disclosure({ title, open, onToggle, children, summary }: { title: ReactNode; open: boolean; onToggle: () => void; children: ReactNode; summary?: ReactNode }) {
  return (
    <div className="panel">
      <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left" aria-expanded={open} onClick={onToggle}>
        <span className="text-sm font-medium">{title}</span>
        <span className="flex items-center gap-2 text-xs text-muted">
          {summary}
          <span aria-hidden className={cx('transition-transform', open && 'rotate-90')}>
            ▸
          </span>
        </span>
      </button>
      {open && <div className="border-t border-line p-3">{children}</div>}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={cx('animate-pulse rounded bg-line/60', className)} aria-hidden />;
}

export function SkeletonRows({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  return (
    <div className={cx('space-y-2', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className={cx('h-4', i % 3 === 0 ? 'w-3/4' : i % 3 === 1 ? 'w-full' : 'w-1/2')} />
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {back && <div className="mb-1 text-xs">{back}</div>}
        <h1 className="text-lg font-semibold leading-6 truncate">{title}</h1>
        {subtitle && <div className="text-xs text-muted mt-0.5">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function NumberInput({
  id,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  nullable = false,
  placeholder,
  className = '',
}: {
  id?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  nullable?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [text, setText] = useState(value == null ? '' : String(value));
  const lastValue = useRef(value);
  useEffect(() => {
    if (lastValue.current !== value) {
      lastValue.current = value;
      setText(value == null ? '' : String(value));
    }
  }, [value]);
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      className={cx('input', className)}
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === '') {
          if (nullable) {
            lastValue.current = null;
            onChange(null);
          }
          return;
        }
        const n = Number(t);
        if (Number.isFinite(n)) {
          lastValue.current = n;
          onChange(n);
        }
      }}
      onBlur={() => {
        if (text.trim() === '' && !nullable) setText(value == null ? '' : String(value));
      }}
    />
  );
}
