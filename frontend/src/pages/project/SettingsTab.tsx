import { useEffect, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { api } from '@/api/endpoints';
import { errorMessage } from '@/api/client';
import type { PipelineSettings } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import { clone, validateSettings } from '@/lib/settingsSchema';
import { toast } from '@/store/uiStore';
import { SettingsForm } from '@/components/settings/SettingsForm';
import { PresetPicker } from '@/components/settings/PresetPicker';
import { EstimateCard } from '@/components/settings/EstimateCard';
import { Field, Note, Panel, Spinner } from '@/components/ui';
import type { ProjectCtx } from './context';

export function SettingsTab({ ctx }: { ctx: ProjectCtx }) {
  const { project, jobActive, reload } = ctx;
  const [settings, setSettings] = useState<PipelineSettings>(() => clone(project.settings));
  const [name, setName] = useState(project.name);
  const [notes, setNotes] = useState(project.notes);
  const [saving, setSaving] = useState(false);
  const presets = useAsync((signal) => api.settingsPresets(signal), []);
  const families = useAsync((signal) => api.tagFamilies(signal), []);

  // Resync from the server copy when the project changes (e.g. after a save or reload).
  useEffect(() => {
    setSettings(clone(project.settings));
    setName(project.name);
    setNotes(project.notes);
  }, [project.settings, project.name, project.notes]);

  const dirty = JSON.stringify(settings) !== JSON.stringify(project.settings) || name !== project.name || notes !== project.notes;
  const errors = validateSettings(settings);
  const valid = Object.keys(errors).length === 0;

  const save = async () => {
    setSaving(true);
    try {
      await api.updateProject(project.id, { name: name.trim() || project.name, settings, notes });
      toast.success('Settings saved');
      reload();
    } catch (e) {
      toast.error('Could not save settings', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-4 items-start">
      <div className="space-y-4">
        {jobActive && <Note kind="info">A job is running. Settings are read-only until it finishes or is cancelled; the engine rejects changes while a job is active.</Note>}
        <Panel title="Project">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" htmlFor="name">
              <input id="name" className="input" value={name} disabled={jobActive} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Notes" htmlFor="notes">
              <textarea id="notes" className="input min-h-[34px]" rows={2} value={notes} disabled={jobActive} onChange={(e) => setNotes(e.target.value)} />
            </Field>
          </div>
        </Panel>
        <Panel title="Preset">
          <PresetPicker presets={presets.data} value={presetMatch(settings, presets.data)} onSelect={(p) => setSettings(clone(p.settings))} disabled={jobActive} />
        </Panel>
        <SettingsForm value={settings} onChange={setSettings} disabled={jobActive} families={families.data} />
      </div>
      <aside className="space-y-3 xl:sticky xl:top-4">
        <EstimateCard settings={settings} probe={project.source} />
        {!valid && (
          <Note kind="error">
            {Object.entries(errors).map(([k, v]) => (
              <div key={k}>
                <code className="code">{k}</code> {v}
              </div>
            ))}
          </Note>
        )}
        <div className="flex gap-2">
          <button type="button" className="btn-primary flex-1 justify-center" disabled={!dirty || !valid || jobActive || saving} onClick={save}>
            {saving ? <Spinner /> : <Save className="h-4 w-4" />} Save
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={!dirty || saving}
            onClick={() => {
              setSettings(clone(project.settings));
              setName(project.name);
              setNotes(project.notes);
            }}
          >
            <RotateCcw className="h-4 w-4" /> Revert
          </button>
        </div>
        <p className="help">Changing settings does not re-run anything. Use <em>Re-run from stage…</em> on the Pipeline tab to apply them (for example from <code className="code">reproject</code> after changing the view layout).</p>
      </aside>
    </div>
  );
}

function presetMatch(settings: PipelineSettings, presets: { id: 'fast' | 'balanced' | 'quality'; settings: PipelineSettings }[] | null): 'fast' | 'balanced' | 'quality' | 'custom' {
  if (!presets) return 'custom';
  const s = JSON.stringify(settings);
  return presets.find((p) => JSON.stringify(p.settings) === s)?.id ?? 'custom';
}
