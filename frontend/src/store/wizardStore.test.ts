import { beforeEach, describe, expect, it } from 'vitest';
import { useWizardStore } from './wizardStore';
import { DEFAULT_SETTINGS, validateSettings } from '@/lib/settingsSchema';
import type { PipelineSettings } from '@/api/types';

describe('wizard store', () => {
  beforeEach(() => useWizardStore.getState().reset());

  it('starts on step 1 with the balanced preset and schema defaults', () => {
    const s = useWizardStore.getState();
    expect(s.step).toBe(1);
    expect(s.presetId).toBe('balanced');
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
    expect(s.settings).not.toBe(DEFAULT_SETTINGS); // cloned, not shared
    expect(validateSettings(s.settings)).toEqual({});
  });

  it('mirrors the engine defaults from models.py', () => {
    const d = DEFAULT_SETTINGS;
    expect(d.keyframes).toMatchObject({ target_count: 200, blur_reject_fraction: 0.25, image_format: 'jpg', jpeg_quality: 95, start_s: null, end_s: null });
    expect(d.views).toMatchObject({ layout: 'cube6', fov_deg: 100, size_px: 1600, nadir_mask: { enabled: true, radius_deg: 30 } });
    expect(d.tags).toMatchObject({ enabled: true, family: 'tag36h11', size_mm: 130, placement: 'floor', min_decision_margin: 30, ids: null });
    expect(d.sfm).toMatchObject({ engine: 'colmap', use_rig: true, window: 6, loop_stride: 10, max_features: 8192, guided_matching: false, min_registered_fraction: 0.6, threads: -1, use_gpu: false });
    expect(d.train).toMatchObject({ backend: 'auto', iterations: 30000, max_resolution: 1600, sh_degree: 3, max_splats: 3_000_000, checkpoint_every: 5000, extra_args: [] });
    expect(d.export).toEqual({ formats: ['ply', 'splat'], keep_intermediates: true });
  });

  it('marks settings as custom when edited and restores a preset when selected', () => {
    const s = useWizardStore.getState();
    const edited: PipelineSettings = { ...s.settings, train: { ...s.settings.train, iterations: 1234 } };
    s.setSettings(edited);
    expect(useWizardStore.getState().presetId).toBe('custom');
    const preset = { ...DEFAULT_SETTINGS, train: { ...DEFAULT_SETTINGS.train, iterations: 15000 } };
    s.setPreset('fast', preset);
    expect(useWizardStore.getState().presetId).toBe('fast');
    expect(useWizardStore.getState().settings.train.iterations).toBe(15000);
    expect(useWizardStore.getState().settings).not.toBe(preset);
  });

  it('adopts the project settings and name when a project is attached', () => {
    const s = useWizardStore.getState();
    const settings = { ...DEFAULT_SETTINGS, tags: { ...DEFAULT_SETTINGS.tags, size_mm: 300 } };
    s.setProject({ id: 'p', name: 'From server', settings } as never);
    expect(useWizardStore.getState().name).toBe('From server');
    expect(useWizardStore.getState().settings.tags.size_mm).toBe(300);
  });

  it('reset clears everything', () => {
    const s = useWizardStore.getState();
    s.setStep(3);
    s.setName('x');
    s.setManualPath('/tmp/a.mp4');
    s.reset();
    expect(useWizardStore.getState()).toMatchObject({ step: 1, name: '', manualPath: '', project: null, upload: { active: false } });
  });
});

describe('validateSettings', () => {
  it('flags out-of-range values and inconsistent trims', () => {
    const bad: PipelineSettings = {
      ...DEFAULT_SETTINGS,
      keyframes: { ...DEFAULT_SETTINGS.keyframes, target_count: 5, start_s: 10, end_s: 5 },
      tags: { ...DEFAULT_SETTINGS.tags, size_mm: 10 },
      export: { formats: [], keep_intermediates: true },
    };
    const errors = validateSettings(bad);
    expect(errors['keyframes.target_count']).toMatch(/at least 20/);
    expect(errors['keyframes.end_s']).toMatch(/after trim start/);
    expect(errors['tags.size_mm']).toMatch(/greater than 10/);
    expect(errors['export.formats']).toBeTruthy();
  });
});
