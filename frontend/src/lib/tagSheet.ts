/**
 * Client-side validation and helpers for the tag sheet form, mirroring the
 * constraints on TagSheetRequest in models.py so we can show problems before
 * calling the engine.
 */
import type { PageSize, TagSheetRequest } from '@/api/types';

export const PAGE_SIZES: { id: PageSize; label: string; mm: [number, number] }[] = [
  { id: 'letter', label: 'US Letter (216 × 279 mm)', mm: [215.9, 279.4] },
  { id: 'a4', label: 'A4 (210 × 297 mm)', mm: [210, 297] },
  { id: 'tabloid', label: 'Tabloid (279 × 432 mm)', mm: [279.4, 431.8] },
  { id: 'a3', label: 'A3 (297 × 420 mm)', mm: [297, 420] },
  { id: 'a2', label: 'A2 (420 × 594 mm)', mm: [420, 594] },
  { id: 'a1', label: 'A1 (594 × 841 mm)', mm: [594, 841] },
  { id: 'a0', label: 'A0 (841 × 1189 mm)', mm: [841, 1189] },
];

export const DEFAULT_SHEET: TagSheetRequest = {
  family: 'tag36h11',
  ids: null,
  first_id: 0,
  count: 12,
  tag_size_mm: 200,
  page: 'letter',
  orientation: 'portrait',
  margin_mm: 10,
  label: true,
  include_guide: true,
  include_scale_check: true,
  project_name: null,
};

/** Parse "0, 1, 2-5 7" into a sorted list of unique non-negative ids. Returns null for empty input. */
export function parseIdList(text: string): { ids: number[] | null; error: string | null } {
  const trimmed = text.trim();
  if (!trimmed) return { ids: null, error: null };
  const out = new Set<number>();
  for (const token of trimmed.split(/[\s,;]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (b < a) return { ids: null, error: `Range "${token}" is reversed.` };
      if (b - a > 200) return { ids: null, error: `Range "${token}" is too long (max 200 ids).` };
      for (let i = a; i <= b; i += 1) out.add(i);
      continue;
    }
    if (!/^\d+$/.test(token)) return { ids: null, error: `"${token}" is not a tag id.` };
    out.add(parseInt(token, 10));
  }
  return { ids: [...out].sort((a, b) => a - b), error: null };
}

export function formatIdList(ids: number[] | null | undefined): string {
  if (!ids || ids.length === 0) return '';
  return ids.join(', ');
}

/** Ids the sheet will contain, for previews. */
export function sheetIds(req: TagSheetRequest, max = 12): number[] {
  const all = req.ids && req.ids.length > 0 ? req.ids : Array.from({ length: Math.max(0, req.count) }, (_, i) => req.first_id + i);
  return all.slice(0, max);
}

export function sheetTagCount(req: TagSheetRequest): number {
  return req.ids && req.ids.length > 0 ? req.ids.length : req.count;
}

export interface TagSheetValidation {
  errors: Partial<Record<keyof TagSheetRequest, string>>;
  valid: boolean;
}

export function validateTagSheet(req: TagSheetRequest, familyCodes?: number): TagSheetValidation {
  const errors: TagSheetValidation['errors'] = {};
  if (!req.family) errors.family = 'Pick a tag family.';
  if (!Number.isFinite(req.first_id) || req.first_id < 0 || !Number.isInteger(req.first_id)) errors.first_id = 'First id must be a whole number ≥ 0.';
  if (!Number.isFinite(req.count) || !Number.isInteger(req.count) || req.count < 1 || req.count > 200) errors.count = 'Count must be between 1 and 200.';
  if (!Number.isFinite(req.tag_size_mm) || req.tag_size_mm <= 10 || req.tag_size_mm > 2000) errors.tag_size_mm = 'Tag size must be greater than 10 mm and at most 2000 mm.';
  if (!Number.isFinite(req.margin_mm) || req.margin_mm < 0 || req.margin_mm > 50) errors.margin_mm = 'Margin must be between 0 and 50 mm.';
  if (req.ids && req.ids.length > 200) errors.ids = 'At most 200 explicit ids.';
  if (req.ids && req.ids.some((i) => i < 0 || !Number.isInteger(i))) errors.ids = 'Ids must be whole numbers ≥ 0.';
  if (familyCodes != null && familyCodes > 0) {
    const ids = req.ids && req.ids.length > 0 ? req.ids : null;
    const maxId = ids ? Math.max(...ids) : req.first_id + req.count - 1;
    if (Number.isFinite(maxId) && maxId >= familyCodes) {
      const key = ids ? 'ids' : 'count';
      errors[key] = `Id ${maxId} exceeds the family (ids 0–${familyCodes - 1}).`;
    }
  }
  if (req.project_name && req.project_name.length > 120) errors.project_name = 'Keep the project name under 120 characters.';
  return { errors, valid: Object.keys(errors).length === 0 };
}

/** Printable area, given page, orientation and margin. */
export function printableArea(req: Pick<TagSheetRequest, 'page' | 'orientation' | 'margin_mm'>): { w: number; h: number } {
  const p = PAGE_SIZES.find((x) => x.id === req.page) ?? PAGE_SIZES[0];
  let [w, h] = p.mm;
  if (req.orientation === 'landscape') [w, h] = [h, w];
  return { w: w - 2 * req.margin_mm, h: h - 2 * req.margin_mm };
}

export function suggestedFilename(req: TagSheetRequest): string {
  const base = req.project_name ? req.project_name.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') : 'apriltags';
  return `${base || 'apriltags'}_${req.family}_${Math.round(req.tag_size_mm)}mm.pdf`;
}
