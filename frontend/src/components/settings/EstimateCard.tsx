import type { PipelineSettings, ProbeInfo } from '@/api/types';
import { estimateRun } from '@/lib/estimate';
import { formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { Stat } from '@/components/ui';

export function EstimateCard({ settings, probe }: { settings: PipelineSettings; probe?: ProbeInfo | null }) {
  const e = estimateRun(settings, probe);
  const hours = settings.train.iterations / 30000;
  return (
    <div className="panel p-3">
      <div className="panel-title mb-2">Live estimate</div>
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Keyframes" value={formatNumber(e.keyframes)} hint={e.clipSeconds != null ? `from ${formatDuration(e.clipSeconds)} of footage` : 'whole clip'} />
        <Stat label="Pinhole views" value={formatNumber(e.views)} hint={`${e.keyframes} × ${e.viewsPerFrame} (${settings.views.layout})`} />
        <Stat label="Disk for images" value={`≈ ${formatBytes(e.totalBytes, 1)}`} hint={`${formatBytes(e.keyframeBytes, 0)} keyframes + ${formatBytes(e.viewBytes, 0)} views`} />
        <Stat label="Training" value={`${formatNumber(settings.train.iterations)} it`} hint={`roughly ${hours < 1 ? `${Math.max(5, Math.round(hours * 60))} min` : `${hours.toFixed(1)} h`} on Apple Silicon`} />
      </div>
      <p className="help mt-2">Rough figures: image sizes depend on scene texture, and the SfM stage scales with views² inside the matching window.</p>
    </div>
  );
}
