/**
 * Defaults and constraints for PipelineSettings, mirrored from models.py so
 * the form works before /api/settings/defaults has answered and so number
 * inputs get the right min/max.
 */
import type { PipelineSettings } from '@/api/types';

export const DEFAULT_SETTINGS: PipelineSettings = {
  keyframes: {
    target_count: 200,
    start_s: null,
    end_s: null,
    blur_reject_fraction: 0.25,
    image_format: 'jpg',
    jpeg_quality: 95,
  },
  views: {
    layout: 'cube6',
    fov_deg: 100,
    size_px: 1600,
    nadir_mask: { enabled: true, radius_deg: 30 },
  },
  tags: {
    enabled: true,
    family: 'tag36h11',
    size_mm: 130,
    placement: 'floor',
    min_decision_margin: 30,
    ids: null,
  },
  sfm: {
    engine: 'colmap',
    use_rig: true,
    window: 6,
    loop_stride: 10,
    max_features: 8192,
    guided_matching: false,
    min_registered_fraction: 0.6,
    threads: -1,
    use_gpu: false,
  },
  train: {
    backend: 'auto',
    iterations: 30000,
    max_resolution: 1600,
    sh_degree: 3,
    max_splats: 3_000_000,
    checkpoint_every: 5000,
    extra_args: [],
  },
  export: {
    formats: ['ply', 'splat'],
    keep_intermediates: true,
  },
};

export interface NumberConstraint {
  min?: number;
  max?: number;
  step?: number;
  exclusiveMin?: boolean;
}

export const CONSTRAINTS = {
  'keyframes.target_count': { min: 20, max: 1200, step: 1 },
  'keyframes.start_s': { min: 0, step: 0.1 },
  'keyframes.end_s': { min: 0, step: 0.1 },
  'keyframes.blur_reject_fraction': { min: 0, max: 0.9, step: 0.05 },
  'keyframes.jpeg_quality': { min: 70, max: 100, step: 1 },
  'views.fov_deg': { min: 80, max: 120, step: 1 },
  'views.size_px': { min: 512, max: 3072, step: 64 },
  'views.nadir_mask.radius_deg': { min: 5, max: 60, step: 1 },
  'tags.size_mm': { min: 10, max: 2000, step: 1, exclusiveMin: true },
  'tags.min_decision_margin': { min: 0, step: 1 },
  'sfm.window': { min: 1, max: 30, step: 1 },
  'sfm.loop_stride': { min: 0, max: 100, step: 1 },
  'sfm.max_features': { min: 1024, max: 32768, step: 256 },
  'sfm.min_registered_fraction': { min: 0, max: 1, step: 0.05 },
  'sfm.threads': { min: -1, step: 1 },
  'train.iterations': { min: 500, max: 200000, step: 500 },
  'train.max_resolution': { min: 256, max: 4096, step: 64 },
  'train.sh_degree': { min: 0, max: 4, step: 1 },
  'train.max_splats': { min: 10_000, max: 20_000_000, step: 10_000 },
  'train.checkpoint_every': { min: 0, step: 500 },
} as const satisfies Record<string, NumberConstraint>;

export type ConstraintKey = keyof typeof CONSTRAINTS;

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Validate a settings object against the constraints. Returns path -> message. */
export function validateSettings(s: PipelineSettings): Record<string, string> {
  const errors: Record<string, string> = {};
  const check = (key: ConstraintKey, value: number | null) => {
    if (value == null) return;
    const c: NumberConstraint = CONSTRAINTS[key];
    if (!Number.isFinite(value)) {
      errors[key] = 'Must be a number';
      return;
    }
    if (c.min != null && (c.exclusiveMin ? value <= c.min : value < c.min)) {
      errors[key] = c.exclusiveMin ? `Must be greater than ${c.min}` : `Must be at least ${c.min}`;
    } else if (c.max != null && value > c.max) {
      errors[key] = `Must be at most ${c.max}`;
    }
  };
  check('keyframes.target_count', s.keyframes.target_count);
  check('keyframes.start_s', s.keyframes.start_s);
  check('keyframes.end_s', s.keyframes.end_s);
  check('keyframes.blur_reject_fraction', s.keyframes.blur_reject_fraction);
  check('keyframes.jpeg_quality', s.keyframes.jpeg_quality);
  check('views.fov_deg', s.views.fov_deg);
  check('views.size_px', s.views.size_px);
  check('views.nadir_mask.radius_deg', s.views.nadir_mask.radius_deg);
  check('tags.size_mm', s.tags.size_mm);
  check('tags.min_decision_margin', s.tags.min_decision_margin);
  check('sfm.window', s.sfm.window);
  check('sfm.loop_stride', s.sfm.loop_stride);
  check('sfm.max_features', s.sfm.max_features);
  check('sfm.min_registered_fraction', s.sfm.min_registered_fraction);
  check('sfm.threads', s.sfm.threads);
  check('train.iterations', s.train.iterations);
  check('train.max_resolution', s.train.max_resolution);
  check('train.sh_degree', s.train.sh_degree);
  check('train.max_splats', s.train.max_splats);
  check('train.checkpoint_every', s.train.checkpoint_every);
  if (s.keyframes.start_s != null && s.keyframes.end_s != null && s.keyframes.end_s <= s.keyframes.start_s) {
    errors['keyframes.end_s'] = 'Trim end must be after trim start';
  }
  if (s.export.formats.length === 0) errors['export.formats'] = 'Pick at least one export format';
  return errors;
}

/** Deep-set helper for dotted paths on a settings clone. */
export function setPath<T extends object>(obj: T, path: string, value: unknown): T {
  const next = clone(obj);
  const parts = path.split('.');
  let cur: Record<string, unknown> = next as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return next;
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const p of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
