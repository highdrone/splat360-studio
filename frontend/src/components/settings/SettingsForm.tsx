import { useId, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, QrCode } from 'lucide-react';
import type { ExportFormat, PipelineSettings, TagFamilyInfo } from '@/api/types';
import { CONSTRAINTS, setPath, validateSettings, type ConstraintKey } from '@/lib/settingsSchema';
import { Field, NumberInput, Toggle, cx } from '@/components/ui';

export interface SettingsFormProps {
  value: PipelineSettings;
  onChange: (next: PipelineSettings) => void;
  disabled?: boolean;
  families?: TagFamilyInfo[] | null;
  /** Show the tag summary block (family / size / placement) above the groups. */
  showTagBanner?: boolean;
  /** Which groups to render; default all. */
  groups?: GroupId[];
}

export type GroupId = 'keyframes' | 'views' | 'tags' | 'sfm' | 'train' | 'export';

export const GROUP_LABELS: Record<GroupId, { title: string; blurb: string }> = {
  keyframes: { title: 'Keyframes', blurb: 'How many frames are pulled from the clip and how blurry ones are rejected.' },
  views: { title: 'Pinhole views', blurb: 'Each equirectangular keyframe is re-projected into several perspective images that COLMAP understands.' },
  tags: { title: 'AprilTags', blurb: 'Printed tags give the scene metric scale and a level floor. Detection is optional but strongly recommended.' },
  sfm: { title: 'Camera tracking (SfM)', blurb: 'Structure-from-motion recovers every camera pose. The rig constraint ties the views of one frame together.' },
  train: { title: 'Training', blurb: 'Gaussian splat optimisation. More iterations and larger resolution mean better quality and longer runs.' },
  export: { title: 'Export', blurb: 'Output formats and what to keep on disk after the run.' },
};

function Group({ id, children, right }: { id: GroupId; children: ReactNode; right?: ReactNode }) {
  const g = GROUP_LABELS[id];
  return (
    <section className="panel" aria-labelledby={`grp-${id}`}>
      <header className="flex items-start justify-between gap-3 px-3 py-2 border-b border-line">
        <div>
          <h3 id={`grp-${id}`} className="text-sm font-medium">
            {g.title}
          </h3>
          <p className="text-2xs text-muted">{g.blurb}</p>
        </div>
        {right}
      </header>
      <div className="grid grid-cols-2 xl:grid-cols-3 gap-x-4 gap-y-3 p-3">{children}</div>
    </section>
  );
}

function Num({
  path,
  label,
  help,
  value,
  onChange,
  disabled,
  errors,
  nullable,
  placeholder,
}: {
  path: ConstraintKey;
  label: string;
  help?: ReactNode;
  value: number | null;
  onChange: (v: number | null) => void;
  disabled?: boolean;
  errors: Record<string, string>;
  nullable?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const c = CONSTRAINTS[path] as { min?: number; max?: number; step?: number };
  return (
    <Field label={label} help={help} error={errors[path]} htmlFor={id}>
      <NumberInput id={id} value={value} onChange={onChange} min={c.min} max={c.max} step={c.step} disabled={disabled} nullable={nullable} placeholder={placeholder} />
    </Field>
  );
}

function Sel<T extends string>({
  label,
  help,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  help?: ReactNode;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} help={help} htmlFor={id}>
      <select id={id} className="select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function Bool({ label, help, value, onChange, disabled }: { label: string; help?: ReactNode; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="min-w-0">
      <Toggle checked={value} onChange={onChange} disabled={disabled} label={label} />
      {help && <div className="help">{help}</div>}
    </div>
  );
}

export function TagBanner({ settings, disabled }: { settings: PipelineSettings; disabled?: boolean }) {
  const t = settings.tags;
  return (
    <div className={cx('rounded-md border px-3 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-2', t.enabled ? 'border-accent/40 bg-accent/10' : 'border-line bg-panel2')}>
      <div className="flex items-center gap-2 text-sm">
        <QrCode className="h-4 w-4 text-accent" />
        {t.enabled ? (
          <span>
            Print <strong>{t.family}</strong> tags at <strong>{t.size_mm} mm</strong>, placed on <strong>{t.placement === 'mixed' ? 'floor and walls' : t.placement}</strong>
          </span>
        ) : (
          <span className="text-muted">Tag detection is off: the scene will have no metric scale and may not be level.</span>
        )}
      </div>
      <div className="text-2xs text-muted">The size you print must match this value exactly, or the scene scale will be wrong.</div>
      <Link to={`/tags?family=${encodeURIComponent(t.family)}&size=${t.size_mm}`} className={cx('btn-secondary btn-sm ml-auto', disabled && 'pointer-events-none opacity-60')}>
        Open Tag Printer <ExternalLink className="h-3 w-3" />
      </Link>
    </div>
  );
}

const ALL_GROUPS: GroupId[] = ['keyframes', 'views', 'tags', 'sfm', 'train', 'export'];

export function SettingsForm({ value, onChange, disabled, families, showTagBanner = true, groups = ALL_GROUPS }: SettingsFormProps) {
  const errors = useMemo(() => validateSettings(value), [value]);
  const [extraArgsText, setExtraArgsText] = useState(value.train.extra_args.join(' '));
  const [idsText, setIdsText] = useState(value.tags.ids ? value.tags.ids.join(', ') : '');
  const set = (path: string, v: unknown) => onChange(setPath(value, path, v));
  const has = (g: GroupId) => groups.includes(g);

  const familyOptions = (families && families.length > 0 ? families.map((f) => f.name) : ['tag36h11', 'tag25h9', 'tag16h5', 'tagStandard41h12', 'tagStandard52h13', 'tagCircle21h7'])
    .concat(value.tags.family)
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((n) => {
      const f = families?.find((x) => x.name === n);
      return { value: n, label: f ? `${n}${f.recommended ? ' (recommended)' : ''}` : n };
    });

  const toggleFormat = (f: ExportFormat, on: boolean) => {
    const cur = new Set(value.export.formats);
    if (on) cur.add(f);
    else cur.delete(f);
    set('export.formats', (['ply', 'splat'] as ExportFormat[]).filter((x) => cur.has(x)));
  };

  return (
    <div className="space-y-3">
      {showTagBanner && has('tags') && <TagBanner settings={value} disabled={disabled} />}

      {has('keyframes') && (
        <Group id="keyframes">
          <Num path="keyframes.target_count" label="Target keyframe count" help="20–1200. 150–300 suits a single room; long walks need more." value={value.keyframes.target_count} onChange={(v) => set('keyframes.target_count', v ?? 200)} disabled={disabled} errors={errors} />
          <Num path="keyframes.start_s" label="Trim start (s)" help="Leave empty to start at 0." value={value.keyframes.start_s} onChange={(v) => set('keyframes.start_s', v)} disabled={disabled} errors={errors} nullable placeholder="0" />
          <Num path="keyframes.end_s" label="Trim end (s)" help="Leave empty for the end of the clip." value={value.keyframes.end_s} onChange={(v) => set('keyframes.end_s', v)} disabled={disabled} errors={errors} nullable placeholder="end" />
          <Num path="keyframes.blur_reject_fraction" label="Blur reject fraction" help="Share of candidate frames dropped as the blurriest (0–0.9)." value={value.keyframes.blur_reject_fraction} onChange={(v) => set('keyframes.blur_reject_fraction', v ?? 0.25)} disabled={disabled} errors={errors} />
          <Sel label="Image format" value={value.keyframes.image_format} options={[{ value: 'jpg', label: 'JPEG (smaller, faster)' }, { value: 'png', label: 'PNG (lossless, ~3× disk)' }]} onChange={(v) => set('keyframes.image_format', v)} disabled={disabled} />
          <Num path="keyframes.jpeg_quality" label="JPEG quality" help="70–100. Only used for JPEG." value={value.keyframes.jpeg_quality} onChange={(v) => set('keyframes.jpeg_quality', v ?? 95)} disabled={disabled || value.keyframes.image_format === 'png'} errors={errors} />
        </Group>
      )}

      {has('views') && (
        <Group id="views">
          <Sel
            label="Layout"
            help="cube6: 6 faces (fast). ring8: 8 around + up + down (more overlap, better tracking)."
            value={value.views.layout}
            options={[{ value: 'cube6', label: 'Cube (6 views per frame)' }, { value: 'ring8', label: 'Ring (8 + up + down = 10 views per frame)' }]}
            onChange={(v) => set('views.layout', v)}
            disabled={disabled}
          />
          <Num path="views.fov_deg" label="Field of view (°)" help="Horizontal FOV per view, 80–120." value={value.views.fov_deg} onChange={(v) => set('views.fov_deg', v ?? 100)} disabled={disabled} errors={errors} />
          <Num path="views.size_px" label="View size (px)" help="Square edge, 512–3072. 1600 px is a good balance." value={value.views.size_px} onChange={(v) => set('views.size_px', v ?? 1600)} disabled={disabled} errors={errors} />
          <Bool label="Mask nadir (tripod / operator)" help="Blacks out a disc at the bottom of the sphere so the stick or your body is not reconstructed." value={value.views.nadir_mask.enabled} onChange={(v) => set('views.nadir_mask.enabled', v)} disabled={disabled} />
          <Num path="views.nadir_mask.radius_deg" label="Nadir mask radius (°)" help="5–60. 30° hides a monopod and feet." value={value.views.nadir_mask.radius_deg} onChange={(v) => set('views.nadir_mask.radius_deg', v ?? 30)} disabled={disabled || !value.views.nadir_mask.enabled} errors={errors} />
        </Group>
      )}

      {has('tags') && (
        <Group id="tags">
          <Bool label="Detect AprilTags" help="Off: no metric scale; alignment falls back to the camera-up heuristic." value={value.tags.enabled} onChange={(v) => set('tags.enabled', v)} disabled={disabled} />
          <Sel label="Family" help={families?.find((f) => f.name === value.tags.family)?.description ?? 'Must match the printed sheet.'} value={value.tags.family} options={familyOptions} onChange={(v) => set('tags.family', v)} disabled={disabled || !value.tags.enabled} />
          <Num path="tags.size_mm" label="Printed tag size (mm)" help="Black square edge as printed. Measure it with a ruler after printing." value={value.tags.size_mm} onChange={(v) => set('tags.size_mm', v ?? 200)} disabled={disabled || !value.tags.enabled} errors={errors} />
          <Sel label="Placement" help="Where the tags are: floor tags define the ground plane directly." value={value.tags.placement} options={[{ value: 'floor', label: 'Floor' }, { value: 'wall', label: 'Walls' }, { value: 'mixed', label: 'Mixed (floor and walls)' }]} onChange={(v) => set('tags.placement', v)} disabled={disabled || !value.tags.enabled} />
          <Num path="tags.min_decision_margin" label="Min decision margin" help="Reject weak detections below this. 30 is conservative; lower for small or distant tags." value={value.tags.min_decision_margin} onChange={(v) => set('tags.min_decision_margin', v ?? 30)} disabled={disabled || !value.tags.enabled} errors={errors} />
          <Field label="Restrict to ids" help="Optional, comma-separated. Leave empty to accept any id of the family." error={errors['tags.ids']}>
            <input
              className="input font-mono"
              value={idsText}
              disabled={disabled || !value.tags.enabled}
              placeholder="e.g. 0, 1, 2, 3"
              onChange={(e) => {
                setIdsText(e.target.value);
                const parts = e.target.value.split(/[\s,;]+/).filter(Boolean);
                if (parts.length === 0) {
                  set('tags.ids', null);
                  return;
                }
                if (parts.every((p) => /^\d+$/.test(p))) set('tags.ids', parts.map((p) => parseInt(p, 10)));
              }}
            />
          </Field>
        </Group>
      )}

      {has('sfm') && (
        <Group id="sfm">
          <Sel label="Engine" help="GLOMAP is a much faster global solver; COLMAP incremental is the robust default." value={value.sfm.engine} options={[{ value: 'colmap', label: 'COLMAP (incremental)' }, { value: 'glomap', label: 'GLOMAP (global, faster)' }]} onChange={(v) => set('sfm.engine', v)} disabled={disabled} />
          <Bool label="Rig constraint" help="Treat the views of one frame as a rigid rig. Recommended." value={value.sfm.use_rig} onChange={(v) => set('sfm.use_rig', v)} disabled={disabled} />
          <Num path="sfm.window" label="Sequential window" help="Match each keyframe with ± this many neighbours (1–30)." value={value.sfm.window} onChange={(v) => set('sfm.window', v ?? 6)} disabled={disabled} errors={errors} />
          <Num path="sfm.loop_stride" label="Loop-closure stride" help="Also match every Nth frame with all others for loop closure (0 = off)." value={value.sfm.loop_stride} onChange={(v) => set('sfm.loop_stride', v ?? 10)} disabled={disabled} errors={errors} />
          <Num path="sfm.max_features" label="Max features per image" help="1024–32768. More features: better on texture-poor walls, slower." value={value.sfm.max_features} onChange={(v) => set('sfm.max_features', v ?? 8192)} disabled={disabled} errors={errors} />
          <Bool label="Guided matching" help="Second matching pass guided by epipolar geometry; more matches, roughly 2× slower." value={value.sfm.guided_matching} onChange={(v) => set('sfm.guided_matching', v)} disabled={disabled} />
          <Num path="sfm.min_registered_fraction" label="Min registered fraction" help="Fail the run if fewer views than this register (0–1)." value={value.sfm.min_registered_fraction} onChange={(v) => set('sfm.min_registered_fraction', v ?? 0.6)} disabled={disabled} errors={errors} />
          <Num path="sfm.threads" label="Threads" help="-1 uses all cores." value={value.sfm.threads} onChange={(v) => set('sfm.threads', v ?? -1)} disabled={disabled} errors={errors} />
          <Bool label="Use GPU for SfM" help="Only honoured when COLMAP was built with CUDA." value={value.sfm.use_gpu} onChange={(v) => set('sfm.use_gpu', v)} disabled={disabled} />
        </Group>
      )}

      {has('train') && (
        <Group id="train">
          <Sel
            label="Backend"
            help="auto picks brush (Metal / Vulkan / CUDA) or OpenSplat, whichever the Environment page found."
            value={value.train.backend}
            options={[{ value: 'auto', label: 'Auto' }, { value: 'brush', label: 'brush' }, { value: 'opensplat', label: 'OpenSplat' }, { value: 'mock', label: 'Mock (no training, test only)' }]}
            onChange={(v) => set('train.backend', v)}
            disabled={disabled}
          />
          <Num path="train.iterations" label="Iterations" help="500–200000. 30k is the reference; 7k is a fast preview." value={value.train.iterations} onChange={(v) => set('train.iterations', v ?? 30000)} disabled={disabled} errors={errors} />
          <Num path="train.max_resolution" label="Max training resolution (px)" help="Longest image side used while training (256–4096)." value={value.train.max_resolution} onChange={(v) => set('train.max_resolution', v ?? 1600)} disabled={disabled} errors={errors} />
          <Num path="train.sh_degree" label="SH degree" help="0–4. 3 gives view-dependent colour; 0 is smallest." value={value.train.sh_degree} onChange={(v) => set('train.sh_degree', v ?? 3)} disabled={disabled} errors={errors} />
          <Num path="train.max_splats" label="Max splats" help="Cap on the number of Gaussians (10k–20M)." value={value.train.max_splats} onChange={(v) => set('train.max_splats', v ?? 3_000_000)} disabled={disabled} errors={errors} />
          <Num path="train.checkpoint_every" label="Checkpoint every N iterations" help="0 = off. Intermediate PLYs appear in Artifacts." value={value.train.checkpoint_every} onChange={(v) => set('train.checkpoint_every', v ?? 5000)} disabled={disabled} errors={errors} />
          <Field label="Extra trainer arguments" help="Passed verbatim to the trainer, space-separated." className="col-span-2 xl:col-span-3">
            <input
              className="input font-mono"
              value={extraArgsText}
              disabled={disabled}
              placeholder="--flag value"
              onChange={(e) => {
                setExtraArgsText(e.target.value);
                set('train.extra_args', e.target.value.split(/\s+/).filter(Boolean));
              }}
            />
          </Field>
        </Group>
      )}

      {has('export') && (
        <Group id="export">
          <div className="min-w-0">
            <div className="label">Formats</div>
            <div className="flex flex-col gap-2">
              <Toggle checked={value.export.formats.includes('ply')} onChange={(v) => toggleFormat('ply', v)} disabled={disabled} label="PLY (3DGS standard, editable)" />
              <Toggle checked={value.export.formats.includes('splat')} onChange={(v) => toggleFormat('splat', v)} disabled={disabled} label=".splat (compact, web viewers)" />
            </div>
            {errors['export.formats'] && <div className="text-2xs text-danger mt-1">{errors['export.formats']}</div>}
          </div>
          <Bool label="Keep intermediates" help="Keep keyframes, views and the COLMAP workspace so stages can be re-run. Off saves disk after export." value={value.export.keep_intermediates} onChange={(v) => set('export.keep_intermediates', v)} disabled={disabled} />
        </Group>
      )}
    </div>
  );
}
