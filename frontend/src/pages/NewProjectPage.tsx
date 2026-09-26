import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, FileVideo, FolderSearch, Play, Upload, X } from 'lucide-react';
import { api } from '@/api/endpoints';
import { errorMessage, type UploadHandle } from '@/api/client';
import type { PipelineSettings, Project, QualityPreset } from '@/api/types';
import { probeHasErrors } from '@/api/types';
import { useWizardStore } from '@/store/wizardStore';
import { toast, confirmDialog } from '@/store/uiStore';
import { useAsync } from '@/hooks/useAsync';
import { bridge, isDesktop } from '@/lib/desktop';
import { basename, formatBytes, formatDuration, formatNumber } from '@/lib/format';
import { validateSettings } from '@/lib/settingsSchema';
import { estimateRun } from '@/lib/estimate';
import { ProbeInfoCard } from '@/components/ProbeInfoCard';
import { SettingsForm, TagBanner } from '@/components/settings/SettingsForm';
import { PresetPicker } from '@/components/settings/PresetPicker';
import { EstimateCard } from '@/components/settings/EstimateCard';
import { Disclosure, Field, KeyValue, Note, PageHeader, Panel, ProgressBar, Spinner, cx } from '@/components/ui';

const STEPS = [
  { n: 1, label: 'Footage' },
  { n: 2, label: 'Settings' },
  { n: 3, label: 'Review & run' },
] as const;

export function NewProjectPage() {
  const w = useWizardStore();
  const navigate = useNavigate();
  const desktop = isDesktop();
  const [busy, setBusy] = useState<string | null>(null);
  const uploadRef = useRef<UploadHandle<Project> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const presets = useAsync((signal) => api.settingsPresets(signal), []);
  const families = useAsync((signal) => api.tagFamilies(signal), []);

  // Apply the default preset's settings from the server once, if the user has not touched anything.
  const appliedDefault = useRef(false);
  useEffect(() => {
    if (appliedDefault.current || !presets.data || w.presetId === 'custom') return;
    const p = presets.data.find((x) => x.id === w.presetId);
    if (p && !w.project) {
      w.setPreset(p.id, p.settings);
      appliedDefault.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets.data]);

  // Abort an in-flight upload when leaving the page.
  useEffect(() => () => uploadRef.current?.abort(), []);

  const ensureProject = async (fallbackName: string): Promise<Project> => {
    if (w.project) return w.project;
    const name = w.name.trim() || fallbackName;
    const p = await api.createProject({ name, settings: w.settings });
    w.setProject(p);
    if (!w.name.trim()) w.setName(name);
    return p;
  };

  const pickDesktop = async () => {
    const b = bridge();
    if (!b) return;
    try {
      const path = await b.pickVideo();
      if (!path) return;
      setBusy('Probing footage…');
      const p = await ensureProject(basename(path).replace(/\.[^.]+$/, ''));
      const updated = await api.setSource(p.id, { path });
      w.setProject(updated);
    } catch (e) {
      toast.error('Could not set the footage', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const applyManualPath = async () => {
    const path = w.manualPath.trim();
    if (!path) return;
    setBusy('Probing footage…');
    try {
      const p = await ensureProject(basename(path).replace(/\.[^.]+$/, ''));
      const updated = await api.setSource(p.id, { path });
      w.setProject(updated);
    } catch (e) {
      toast.error('Could not set the footage', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const uploadFile = async (file: File) => {
    setBusy('Uploading…');
    w.setUpload({ active: true, progress: 0, total: file.size });
    try {
      const p = await ensureProject(file.name.replace(/\.[^.]+$/, ''));
      const h = api.uploadSource(p.id, file, (loaded, total) => w.setUpload({ progress: loaded, total }));
      uploadRef.current = h;
      const updated = await h.promise;
      w.setProject(updated);
      toast.success('Upload complete', 'The footage was probed.');
    } catch (e) {
      toast.error('Upload failed', errorMessage(e));
    } finally {
      uploadRef.current = null;
      w.setUpload({ active: false });
      setBusy(null);
    }
  };

  const cancelUpload = () => uploadRef.current?.abort();

  const probe = w.project?.source ?? null;
  const hasErrors = probeHasErrors(probe);
  const settingsErrors = validateSettings(w.settings);
  const settingsValid = Object.keys(settingsErrors).length === 0;
  const canContinue1 = !!probe && !hasErrors && !busy;

  const selectPreset = (p: QualityPreset) => w.setPreset(p.id, p.settings);

  const saveSettings = async (): Promise<Project | null> => {
    if (!w.project) return null;
    const updated = await api.updateProject(w.project.id, { name: w.name.trim() || w.project.name, settings: w.settings });
    w.setProject(updated);
    return updated;
  };

  const goStep3 = async () => {
    if (!settingsValid) {
      toast.warning('Fix the settings first', Object.values(settingsErrors)[0]);
      return;
    }
    setBusy('Saving settings…');
    try {
      await saveSettings();
      w.setStep(3);
    } catch (e) {
      toast.error('Could not save settings', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    if (!w.project) return;
    setBusy('Starting run…');
    try {
      const p = (await saveSettings()) ?? w.project;
      await api.runProject(p.id, {});
      const id = p.id;
      w.reset();
      toast.success('Run started', p.name);
      navigate(`/projects/${id}`);
    } catch (e) {
      toast.error('Could not start the run', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const saveOnly = async () => {
    if (!w.project) return;
    setBusy('Saving…');
    try {
      const p = (await saveSettings()) ?? w.project;
      const id = p.id;
      w.reset();
      navigate(`/projects/${id}`);
    } catch (e) {
      toast.error('Could not save the project', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    if (w.project) {
      const ok = await confirmDialog({ title: 'Discard this project?', message: `The project “${w.project.name}” was already created on disk. Delete it and start over?`, confirmLabel: 'Delete and start over', danger: true });
      if (!ok) return;
      try {
        await api.deleteProject(w.project.id);
      } catch (e) {
        toast.error('Could not delete the project', errorMessage(e));
        return;
      }
    }
    w.reset();
  };

  const est = estimateRun(w.settings, probe);

  return (
    <div>
      <PageHeader
        title="New project"
        back={
          <Link to="/" className="text-muted hover:text-ink inline-flex items-center gap-1">
            <ArrowLeft className="h-3 w-3" /> Projects
          </Link>
        }
        actions={
          (w.project || w.name) && (
            <button type="button" className="btn-ghost" onClick={discard}>
              <X className="h-4 w-4" /> {w.project ? 'Discard' : 'Reset'}
            </button>
          )
        }
      />
      <ol className="mb-5 flex items-center gap-2 text-xs" aria-label="Steps">
        {STEPS.map((s, i) => {
          const state = w.step === s.n ? 'current' : w.step > s.n ? 'done' : 'todo';
          return (
            <li key={s.n} className="flex items-center gap-2">
              <button
                type="button"
                className={cx('inline-flex items-center gap-2 rounded-full border px-2.5 py-1', state === 'current' ? 'border-accent text-accent bg-accent/10' : state === 'done' ? 'border-ok/50 text-ok' : 'border-line text-faint')}
                disabled={state === 'todo'}
                onClick={() => state === 'done' && w.setStep(s.n)}
                aria-current={state === 'current' ? 'step' : undefined}
              >
                <span className="grid h-4 w-4 place-items-center rounded-full border border-current text-2xs">{state === 'done' ? <Check className="h-3 w-3" /> : s.n}</span>
                {s.label}
              </button>
              {i < STEPS.length - 1 && <span className="h-px w-8 bg-line" aria-hidden />}
            </li>
          );
        })}
      </ol>

      {w.step === 1 && (
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-4 items-start">
          <div className="space-y-4">
            <Panel title="Project">
              <Field label="Name" htmlFor="pname" help="Defaults to the video file name.">
                <input id="pname" className="input max-w-md" value={w.name} placeholder="Living room, Workshop, …" onChange={(e) => w.setName(e.target.value)} maxLength={120} />
              </Field>
            </Panel>
            <Panel title="Footage">
              <p className="text-xs text-muted mb-3">
                An equirectangular MP4 exported from Insta360 Studio (8K, H.265/H.264). Raw <code className="code">.insv</code> files are rejected. See the <Link to="/guide#export" className="text-accent underline">export steps</Link>.
              </p>
              {desktop ? (
                <div className="flex items-center gap-2">
                  <button type="button" className="btn-primary" onClick={pickDesktop} disabled={!!busy}>
                    {busy ? <Spinner /> : <FileVideo className="h-4 w-4" />} Choose video…
                  </button>
                  <span className="text-2xs text-faint">The file is used in place; nothing is copied.</span>
                </div>
              ) : (
                <div className="space-y-3">
                  <div
                    className="rounded-md border border-dashed border-line p-5 text-center hover:border-accent/60"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = e.dataTransfer.files?.[0];
                      if (f) void uploadFile(f);
                    }}
                  >
                    <Upload className="mx-auto h-6 w-6 text-faint" />
                    <div className="mt-2 text-sm">Drop the MP4 here or</div>
                    <button type="button" className="btn-primary mt-2" onClick={() => fileInputRef.current?.click()} disabled={!!busy}>
                      {w.upload.active ? <Spinner /> : <Upload className="h-4 w-4" />} Upload video
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="video/mp4,video/quicktime,.mp4,.mov,.insv"
                      className="sr-only"
                      aria-label="Upload video"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void uploadFile(f);
                        e.target.value = '';
                      }}
                    />
                    <div className="mt-1 text-2xs text-faint">Uploads copy the file into the project's work directory (8K clips are several GB).</div>
                    {w.upload.active && (
                      <div className="mt-3 text-left">
                        <div className="flex justify-between text-2xs text-muted mb-1">
                          <span>
                            {formatBytes(w.upload.progress)} of {formatBytes(w.upload.total)}
                          </span>
                          <button type="button" className="text-danger underline" onClick={cancelUpload}>
                            Cancel
                          </button>
                        </div>
                        <ProgressBar value={w.upload.total ? w.upload.progress / w.upload.total : 0} />
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="label">Or enter a path on this machine</div>
                    <div className="flex gap-2">
                      <input className="input font-mono" placeholder="/Users/you/Movies/room_8k.mp4" value={w.manualPath} onChange={(e) => w.setManualPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyManualPath()} aria-label="Video path" />
                      <button type="button" className="btn-secondary" onClick={applyManualPath} disabled={!w.manualPath.trim() || !!busy}>
                        <FolderSearch className="h-4 w-4" /> Use path
                      </button>
                    </div>
                    <div className="help">The engine reads the file where it is; nothing is copied. The path must exist on the machine running the engine.</div>
                  </div>
                </div>
              )}
              {busy && !w.upload.active && (
                <div className="mt-3 flex items-center gap-2 text-xs text-muted">
                  <Spinner /> {busy}
                </div>
              )}
            </Panel>
            {probe && (
              <Panel title="Footage check">
                <ProbeInfoCard probe={probe} />
                {hasErrors ? (
                  <Note kind="error">
                    <strong>This footage cannot be processed.</strong> Fix the errors above (usually by re-exporting from Insta360 Studio) and choose the file again.
                  </Note>
                ) : probe.issues.some((i) => i.level === 'warning') ? (
                  <div className="mt-3">
                    <Note kind="warning">There are warnings. You can continue, but results may be worse than with the recommended export settings.</Note>
                  </div>
                ) : (
                  <div className="mt-3">
                    <Note kind="success">Footage looks good.</Note>
                  </div>
                )}
              </Panel>
            )}
          </div>
          <aside className="space-y-3">
            <Panel title="Before you continue">
              <ul className="text-xs text-muted space-y-1.5 list-disc pl-4">
                <li>Export as 360° equirectangular, 8K, FlowState on, Direction Lock off.</li>
                <li>Have your printed AprilTag size ready (mm).</li>
                <li>Check that COLMAP and a trainer were found on the <Link to="/doctor" className="text-accent underline">Environment</Link> page.</li>
              </ul>
            </Panel>
            <div className="flex justify-end">
              <button type="button" className="btn-primary" disabled={!canContinue1} onClick={() => w.setStep(2)}>
                Continue <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </aside>
        </div>
      )}

      {w.step === 2 && (
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 items-start">
          <div className="space-y-4">
            <Panel title="Quality preset">
              {presets.error && <Note kind="error">Could not load presets: {presets.error}</Note>}
              <PresetPicker presets={presets.data} value={w.presetId} onSelect={selectPreset} />
            </Panel>
            <TagBanner settings={w.settings} />
            <Disclosure title="Advanced settings" open={w.advancedOpen} onToggle={() => w.setAdvancedOpen(!w.advancedOpen)} summary={w.presetId === 'custom' ? 'customised' : `preset: ${w.presetId}`}>
              <SettingsForm value={w.settings} onChange={(s: PipelineSettings) => w.setSettings(s)} families={families.data} showTagBanner={false} />
            </Disclosure>
          </div>
          <aside className="space-y-3 xl:sticky xl:top-4">
            <EstimateCard settings={w.settings} probe={probe} />
            {!settingsValid && (
              <Note kind="error">
                {Object.entries(settingsErrors).map(([k, v]) => (
                  <div key={k}>
                    <code className="code">{k}</code> {v}
                  </div>
                ))}
              </Note>
            )}
            <div className="flex justify-between">
              <button type="button" className="btn-secondary" onClick={() => w.setStep(1)}>
                <ArrowLeft className="h-4 w-4" /> Back
              </button>
              <button type="button" className="btn-primary" onClick={goStep3} disabled={!settingsValid || !!busy}>
                {busy ? <Spinner /> : null} Continue <ArrowRight className="h-4 w-4" />
              </button>
            </div>
          </aside>
        </div>
      )}

      {w.step === 3 && w.project && (
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4 items-start">
          <div className="space-y-4">
            <Panel title="Summary">
              <KeyValue
                items={[
                  { k: 'Project', v: w.name || w.project.name },
                  { k: 'Footage', v: probe ? `${probe.filename} · ${probe.width}×${probe.height} · ${formatDuration(probe.duration_s)}` : '—' },
                  { k: 'Preset', v: w.presetId === 'custom' ? 'Custom' : (presets.data?.find((p) => p.id === w.presetId)?.label ?? w.presetId) },
                  { k: 'Keyframes', v: `${formatNumber(est.keyframes)} → ${formatNumber(est.views)} views (${w.settings.views.layout}, ${w.settings.views.size_px} px)` },
                  { k: 'Tags', v: w.settings.tags.enabled ? `${w.settings.tags.family}, ${w.settings.tags.size_mm} mm, ${w.settings.tags.placement}` : 'disabled' },
                  { k: 'SfM', v: `${w.settings.sfm.engine}${w.settings.sfm.use_rig ? ' + rig' : ''}, window ${w.settings.sfm.window}, ${formatNumber(w.settings.sfm.max_features)} features` },
                  { k: 'Training', v: `${w.settings.train.backend}, ${formatNumber(w.settings.train.iterations)} iterations, ${w.settings.train.max_resolution} px, ≤ ${formatNumber(w.settings.train.max_splats)} splats` },
                  { k: 'Export', v: w.settings.export.formats.join(', ') || 'none' },
                  { k: 'Estimated disk', v: `≈ ${formatBytes(est.totalBytes)} for images` },
                  { k: 'Work directory', v: <code className="code">{w.project.workdir}</code> },
                ]}
              />
            </Panel>
            <Note kind="info">
              The run goes through all eight stages: validate, keyframes, pinhole views, tags, SfM, alignment, training, export. You can watch progress and logs on the project page, cancel at any time, and re-run from any stage later.
            </Note>
          </div>
          <aside className="space-y-3">
            <div className="flex flex-col gap-2">
              <button type="button" className="btn-primary justify-center" onClick={run} disabled={!!busy}>
                {busy ? <Spinner /> : <Play className="h-4 w-4" />} Run pipeline
              </button>
              <button type="button" className="btn-secondary justify-center" onClick={saveOnly} disabled={!!busy}>
                Save without running
              </button>
              <button type="button" className="btn-ghost justify-center" onClick={() => w.setStep(2)} disabled={!!busy}>
                <ArrowLeft className="h-4 w-4" /> Back to settings
              </button>
            </div>
          </aside>
        </div>
      )}
      {w.step === 3 && !w.project && (
        <Note kind="warning">
          No footage selected yet.{' '}
          <button type="button" className="underline" onClick={() => w.setStep(1)}>
            Go back to step 1.
          </button>
        </Note>
      )}
    </div>
  );
}
