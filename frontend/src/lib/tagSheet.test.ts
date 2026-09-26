import { describe, expect, it } from 'vitest';
import { DEFAULT_SHEET, parseIdList, printableArea, sheetIds, sheetTagCount, suggestedFilename, validateTagSheet } from './tagSheet';

describe('validateTagSheet', () => {
  it('accepts the defaults', () => {
    expect(validateTagSheet(DEFAULT_SHEET).valid).toBe(true);
  });
  it('rejects a tag size at or below 10 mm and above 2000 mm', () => {
    expect(validateTagSheet({ ...DEFAULT_SHEET, tag_size_mm: 10 }).errors.tag_size_mm).toBeTruthy();
    expect(validateTagSheet({ ...DEFAULT_SHEET, tag_size_mm: 2001 }).errors.tag_size_mm).toBeTruthy();
    expect(validateTagSheet({ ...DEFAULT_SHEET, tag_size_mm: 10.5 }).valid).toBe(true);
  });
  it('rejects bad counts, margins and negative ids', () => {
    expect(validateTagSheet({ ...DEFAULT_SHEET, count: 0 }).errors.count).toBeTruthy();
    expect(validateTagSheet({ ...DEFAULT_SHEET, count: 201 }).errors.count).toBeTruthy();
    expect(validateTagSheet({ ...DEFAULT_SHEET, margin_mm: 51 }).errors.margin_mm).toBeTruthy();
    expect(validateTagSheet({ ...DEFAULT_SHEET, first_id: -1 }).errors.first_id).toBeTruthy();
    expect(validateTagSheet({ ...DEFAULT_SHEET, ids: [1, -2] }).errors.ids).toBeTruthy();
  });
  it('checks ids against the family size when known', () => {
    expect(validateTagSheet({ ...DEFAULT_SHEET, first_id: 580, count: 12 }, 587).errors.count).toMatch(/exceeds/);
    expect(validateTagSheet({ ...DEFAULT_SHEET, ids: [0, 600] }, 587).errors.ids).toMatch(/exceeds/);
    expect(validateTagSheet({ ...DEFAULT_SHEET, first_id: 575, count: 12 }, 587).valid).toBe(true);
  });
});

describe('parseIdList', () => {
  it('parses lists and ranges into sorted unique ids', () => {
    expect(parseIdList('3, 1 2-4;7').ids).toEqual([1, 2, 3, 4, 7]);
    expect(parseIdList('').ids).toBeNull();
    expect(parseIdList('  ').error).toBeNull();
  });
  it('reports malformed tokens and reversed ranges', () => {
    expect(parseIdList('a').error).toMatch(/not a tag id/);
    expect(parseIdList('5-2').error).toMatch(/reversed/);
  });
});

describe('sheet helpers', () => {
  it('derives ids from first_id/count or explicit ids', () => {
    expect(sheetIds({ ...DEFAULT_SHEET, first_id: 4, count: 3 })).toEqual([4, 5, 6]);
    expect(sheetIds({ ...DEFAULT_SHEET, ids: [9, 8] })).toEqual([9, 8]);
    expect(sheetTagCount({ ...DEFAULT_SHEET, ids: [9, 8] })).toBe(2);
    expect(sheetTagCount({ ...DEFAULT_SHEET, count: 5, ids: null })).toBe(5);
  });
  it('computes the printable area with orientation and margins', () => {
    const a = printableArea({ page: 'a4', orientation: 'portrait', margin_mm: 10 });
    expect(a).toEqual({ w: 190, h: 277 });
    const b = printableArea({ page: 'a4', orientation: 'landscape', margin_mm: 0 });
    expect(b).toEqual({ w: 297, h: 210 });
  });
  it('builds a safe filename', () => {
    expect(suggestedFilename({ ...DEFAULT_SHEET, project_name: 'Living room / v2', tag_size_mm: 200.4 })).toBe('Living_room_v2_tag36h11_200mm.pdf');
    expect(suggestedFilename(DEFAULT_SHEET)).toBe('apriltags_tag36h11_130mm.pdf');
  });
});
