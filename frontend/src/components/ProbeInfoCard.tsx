import { AlertTriangle, Info, XCircle } from 'lucide-react';
import type { ProbeInfo } from '@/api/types';
import { formatBytes, formatDuration, formatNumber, formatResolution } from '@/lib/format';
import { Note, PathChip, Stat, cx } from '@/components/ui';

const LEVEL_STYLE = {
  error: { icon: XCircle, cls: 'border-danger/40 bg-danger/10', text: 'text-danger' },
  warning: { icon: AlertTriangle, cls: 'border-warn/50 bg-warn/10', text: 'text-warn' },
  info: { icon: Info, cls: 'border-info/40 bg-info/10', text: 'text-info' },
};

export function ProbeIssues({ probe }: { probe: ProbeInfo }) {
  if (probe.issues.length === 0) return null;
  return (
    <ul className="space-y-1.5" aria-label="Footage issues">
      {probe.issues.map((i, idx) => {
        const s = LEVEL_STYLE[i.level];
        const Icon = s.icon;
        return (
          <li key={`${i.code}-${idx}`} className={cx('rounded-md border px-3 py-2 text-xs flex gap-2', s.cls)}>
            <Icon className={cx('h-4 w-4 shrink-0 mt-0.5', s.text)} />
            <div className="min-w-0">
              <div className="text-ink">
                <span className={cx('font-semibold uppercase text-2xs mr-1.5', s.text)}>{i.level}</span>
                {i.message}
              </div>
              {i.hint && <div className="text-muted mt-0.5">{i.hint}</div>}
              <div className="text-2xs text-faint font-mono mt-0.5">{i.code}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ProbeInfoCard({ probe, compact = false }: { probe: ProbeInfo; compact?: boolean }) {
  const projection = probe.projection === 'equirectangular' ? 'Equirectangular' : probe.projection === 'dual_fisheye' ? 'Dual fisheye' : 'Unknown';
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate" title={probe.filename}>
            {probe.filename}
          </div>
          <div className="mt-0.5">
            <PathChip path={probe.path} />
          </div>
        </div>
        <div className="text-xs text-muted">
          {formatBytes(probe.size_bytes)}
          {probe.camera_make || probe.camera_model ? ` · ${[probe.camera_make, probe.camera_model].filter(Boolean).join(' ')}` : ''}
        </div>
      </div>
      <div className={cx('grid gap-3', compact ? 'grid-cols-3' : 'grid-cols-3 lg:grid-cols-6')}>
        <Stat label="Resolution" value={formatResolution(probe.width, probe.height)} />
        <Stat label="Frame rate" value={probe.fps ? `${probe.fps % 1 === 0 ? probe.fps : probe.fps.toFixed(2)} fps` : '—'} />
        <Stat label="Duration" value={formatDuration(probe.duration_s)} hint={probe.frame_count ? `${formatNumber(probe.frame_count)} frames` : undefined} />
        <Stat label="Codec" value={probe.codec ?? '—'} hint={[probe.container, probe.pix_fmt].filter(Boolean).join(' · ') || undefined} />
        <Stat label="Projection" value={projection} hint={probe.is_equirectangular ? '2:1 sphere' : undefined} />
        <Stat label="Bit rate" value={probe.bit_rate ? `${(probe.bit_rate / 1e6).toFixed(0)} Mb/s` : '—'} />
      </div>
      {probe.is_insta360_raw && (
        <Note kind="warning">
          <strong>This is a raw Insta360 file.</strong> The camera writes dual-fisheye <code className="code">.insv</code> files that the pipeline cannot stitch. Open the clip in{' '}
          <strong>Insta360 Studio</strong>, choose Export → Video, set the projection to <em>360° / equirectangular</em> at 8K (7680 × 3840), H.265 or H.264, FlowState stabilization on and
          Direction Lock off, then pick the exported <code className="code">.mp4</code> here.
        </Note>
      )}
      <ProbeIssues probe={probe} />
    </div>
  );
}
