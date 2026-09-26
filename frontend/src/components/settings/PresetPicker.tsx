import type { PresetId, QualityPreset } from '@/api/types';
import { cx, Skeleton } from '@/components/ui';

export function PresetPicker({
  presets,
  value,
  onSelect,
  disabled,
}: {
  presets: QualityPreset[] | null;
  value: PresetId | 'custom';
  onSelect: (p: QualityPreset) => void;
  disabled?: boolean;
}) {
  if (!presets) {
    return (
      <div className="grid grid-cols-3 gap-3" role="status" aria-label="Loading presets">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-3 gap-3" role="radiogroup" aria-label="Quality preset">
      {presets.map((p) => {
        const active = value === p.id;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onSelect(p)}
            className={cx('text-left rounded-md border p-3 transition-colors disabled:opacity-60', active ? 'border-accent bg-accent/10' : 'border-line bg-panel hover:border-faint')}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold">{p.label}</span>
              <span className={cx('h-3 w-3 rounded-full border', active ? 'border-accent bg-accent' : 'border-line')} aria-hidden />
            </div>
            <p className="mt-1 text-xs text-muted leading-4">{p.description}</p>
            <dl className="mt-2 grid grid-cols-3 gap-1 text-2xs text-faint">
              <div>
                <dt>Keyframes</dt>
                <dd className="text-muted">{p.settings.keyframes.target_count}</dd>
              </div>
              <div>
                <dt>Views</dt>
                <dd className="text-muted">
                  {p.settings.views.size_px}px {p.settings.views.layout}
                </dd>
              </div>
              <div>
                <dt>Iterations</dt>
                <dd className="text-muted">{p.settings.train.iterations.toLocaleString()}</dd>
              </div>
            </dl>
          </button>
        );
      })}
      {value === 'custom' && (
        <div className="col-span-3 text-2xs text-muted">
          Custom settings (edited below). Select a preset to reset them.
        </div>
      )}
    </div>
  );
}
