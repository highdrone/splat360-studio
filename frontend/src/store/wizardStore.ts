import { create } from 'zustand';
import type { PipelineSettings, PresetId, Project } from '@/api/types';
import { DEFAULT_SETTINGS, clone } from '@/lib/settingsSchema';

export type WizardStep = 1 | 2 | 3;

interface WizardState {
  step: WizardStep;
  name: string;
  /** Project created on the server as soon as the user picks footage. */
  project: Project | null;
  presetId: PresetId | 'custom';
  settings: PipelineSettings;
  advancedOpen: boolean;
  /** Path typed manually in the browser fallback. */
  manualPath: string;
  upload: { progress: number; total: number; active: boolean };

  setStep: (s: WizardStep) => void;
  setName: (n: string) => void;
  setProject: (p: Project | null) => void;
  setPreset: (id: PresetId | 'custom', settings?: PipelineSettings) => void;
  setSettings: (s: PipelineSettings) => void;
  setAdvancedOpen: (open: boolean) => void;
  setManualPath: (p: string) => void;
  setUpload: (u: Partial<WizardState['upload']>) => void;
  reset: () => void;
}

const initial = () => ({
  step: 1 as WizardStep,
  name: '',
  project: null,
  presetId: 'balanced' as PresetId | 'custom',
  settings: clone(DEFAULT_SETTINGS),
  advancedOpen: false,
  manualPath: '',
  upload: { progress: 0, total: 0, active: false },
});

export const useWizardStore = create<WizardState>((set) => ({
  ...initial(),
  setStep: (step) => set({ step }),
  setName: (name) => set({ name }),
  setProject: (project) =>
    set((s) => ({
      project,
      name: s.name || project?.name || '',
      settings: project ? clone(project.settings) : s.settings,
    })),
  setPreset: (presetId, settings) =>
    set((s) => ({ presetId, settings: settings ? clone(settings) : s.settings })),
  setSettings: (settings) => set({ settings, presetId: 'custom' }),
  setAdvancedOpen: (advancedOpen) => set({ advancedOpen }),
  setManualPath: (manualPath) => set({ manualPath }),
  setUpload: (u) => set((s) => ({ upload: { ...s.upload, ...u } })),
  reset: () => set(initial()),
}));
