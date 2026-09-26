import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Download, Pause, Play } from 'lucide-react';
import { CopyButton, cx } from '@/components/ui';

export function LogPanel({ lines, seq, downloadUrl, height = 360 }: { lines: string[]; seq: number; downloadUrl?: string; height?: number }) {
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    if (!filter.trim()) return lines;
    const f = filter.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(f));
  }, [lines, filter]);

  useEffect(() => {
    if (!follow) return;
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [seq, follow, shown.length]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (!atBottom && follow) setFollow(false);
    else if (atBottom && !follow) setFollow(true);
  };

  const classify = (l: string) => {
    const s = l.toLowerCase();
    if (/\berror\b|traceback|exception|failed/.test(s)) return 'text-danger';
    if (/\bwarn(ing)?\b/.test(s)) return 'text-warn';
    return 'text-muted';
  };

  return (
    <div className="panel flex flex-col">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <h3 className="panel-title">Log</h3>
        <span className="text-2xs text-faint">
          {shown.length === lines.length ? `${lines.length} lines` : `${shown.length} of ${lines.length} lines`}
        </span>
        <input className="input ml-auto max-w-[220px] py-1 text-xs" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter log lines" />
        <button type="button" className={cx('btn-ghost btn-sm', follow && 'text-accent')} onClick={() => setFollow((f) => !f)} aria-pressed={follow} title={follow ? 'Auto-scroll on (click to pause)' : 'Auto-scroll paused (click to resume)'}>
          {follow ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />} {follow ? 'Following' : 'Paused'}
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm"
          title="Jump to end"
          aria-label="Jump to end"
          onClick={() => {
            setFollow(true);
            const el = boxRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          <ArrowDownToLine className="h-3 w-3" />
        </button>
        <CopyButton text={shown.join('\n')} label="Copy" />
        {downloadUrl && (
          <a className="btn-ghost btn-sm" href={downloadUrl} target="_blank" rel="noreferrer" title="Open the full log">
            <Download className="h-3 w-3" />
          </a>
        )}
      </header>
      <div ref={boxRef} onScroll={onScroll} className="overflow-auto bg-bg font-mono text-2xs leading-4 p-2" style={{ height }} role="log" aria-live="polite" aria-label="Job log">
        {shown.length === 0 ? (
          <div className="text-faint p-2">{lines.length === 0 ? 'No log output yet.' : 'No lines match the filter.'}</div>
        ) : (
          shown.map((l, i) => (
            <div key={i} className={cx('log-line', classify(l))}>
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
