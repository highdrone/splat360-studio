/** Formatting helpers shared across the UI. */

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  if (bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const d = i === 0 ? 0 : digits;
  return `${v.toFixed(d)} ${units[i]}`;
}

/** Seconds -> "1h 02m 03s", "4m 05s", "12.3s". */
export function formatDuration(seconds: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, seconds);
  if (s < 60) return opts.compact ? `${Math.round(s)}s` : `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.round(s % 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  return `${m}m ${pad(sec)}s`;
}

/** Seconds -> "0:34.5" style timecode for keyframes. */
export function formatTimecode(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

export function formatPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function formatFixed(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

/** ISO date -> relative time ("3 min ago", "in 2 h", "yesterday"). */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = (t - now) / 1000; // positive = future
  const abs = Math.abs(diff);
  const past = diff < 0;
  const fmt = (n: number, unit: string) => {
    const v = Math.round(n);
    const label = `${v} ${unit}${v === 1 ? '' : 's'}`;
    return past ? `${label} ago` : `in ${label}`;
  };
  if (abs < 10) return 'just now';
  if (abs < 60) return fmt(abs, 'second');
  if (abs < 3600) return fmt(abs / 60, 'minute');
  if (abs < 86400) return fmt(abs / 3600, 'hour');
  if (abs < 86400 * 2) return past ? 'yesterday' : 'tomorrow';
  if (abs < 86400 * 30) return fmt(abs / 86400, 'day');
  if (abs < 86400 * 365) return fmt(abs / (86400 * 30), 'month');
  return fmt(abs / (86400 * 365), 'year');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  return t.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Elapsed seconds between two ISO timestamps (or until now). */
export function elapsedSeconds(start: string | null | undefined, end?: string | null, now: number = Date.now()): number | null {
  if (!start) return null;
  const s = Date.parse(start);
  if (Number.isNaN(s)) return null;
  const e = end ? Date.parse(end) : now;
  if (Number.isNaN(e)) return null;
  return Math.max(0, (e - s) / 1000);
}

export function formatResolution(w: number | null | undefined, h: number | null | undefined): string {
  if (!w || !h) return '—';
  const tag = w >= 7000 ? ' (8K)' : w >= 5000 ? ' (5.7K)' : w >= 3800 ? ' (4K)' : '';
  return `${w} × ${h}${tag}`;
}

/** Truncate the middle of long paths for display. */
export function shortenPath(path: string, max = 60): string {
  if (path.length <= max) return path;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Render a metric value for a key/value chip. */
export function formatMetric(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return formatNumber(value);
    return Math.abs(value) < 1 ? value.toFixed(3) : value.toFixed(2);
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function humanKey(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
