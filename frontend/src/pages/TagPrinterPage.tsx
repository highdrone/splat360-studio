import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, FileText, Printer, Save, Sparkles } from 'lucide-react';
import { api } from '@/api/endpoints';
import { ApiError, errorMessage } from '@/api/client';
import type { TagPlan, TagPlanRequest, TagSheetLayout, TagSheetRequest } from '@/api/types';
import { useAsync } from '@/hooks/useAsync';
import { DEFAULT_SHEET, PAGE_SIZES, formatIdList, parseIdList, printableArea, sheetIds, sheetTagCount, suggestedFilename, validateTagSheet } from '@/lib/tagSheet';
import { bridge, downloadBlob, isDesktop } from '@/lib/desktop';
import { toast } from '@/store/uiStore';
import { Field, Note, NumberInput, PageHeader, Panel, Skeleton, Spinner, Toggle, cx } from '@/components/ui';

const DEFAULT_PLAN: TagPlanRequest = { area_m2: 50, scene: 'room', walk_length_m: 20, ceiling_height_m: 2.7, printer_max_mm: 279 };

export function TagPrinterPage() {
  const [params] = useSearchParams();
  const [req, setReq] = useState<TagSheetRequest>(() => ({
    ...DEFAULT_SHEET,
    family: params.get('family') || DEFAULT_SHEET.family,
    tag_size_mm: Number(params.get('size')) > 10 ? Number(params.get('size')) : DEFAULT_SHEET.tag_size_mm,
    project_name: params.get('project') || null,
  }));
  const [idsText, setIdsText] = useState(formatIdList(req.ids));
  const [idsError, setIdsError] = useState<string | null>(null);
  const families = useAsync((signal) => api.tagFamilies(signal), []);
  const family = families.data?.find((f) => f.name === req.family);
  const validation = useMemo(() => validateTagSheet(req, family?.ncodes), [req, family]);
  const errors = { ...validation.errors, ...(idsError ? { ids: idsError } : {}) };
  const valid = validation.valid && !idsError;

  // Layout preview (debounced).
  const [layout, setLayout] = useState<TagSheetLayout | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  useEffect(() => {
    if (!valid) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLayoutBusy(true);
      api
        .tagSheetLayout(req, ctrl.signal)
        .then((l) => {
          setLayout(l);
          setLayoutError(null);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          setLayout(null);
          setLayoutError(e instanceof ApiError && e.status === 422 ? e.detail : errorMessage(e));
        })
        .finally(() => setLayoutBusy(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [req, valid]);

  // PDF generation.
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBlob, setPdfBlob] = useState<Blob | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const pdfUrlRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    },
    [],
  );
  const generate = async () => {
    setPdfBusy(true);
    try {
      const blob = await api.tagSheet(req);
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      const url = URL.createObjectURL(blob);
      pdfUrlRef.current = url;
      setPdfBlob(blob);
      setPdfUrl(url);
      toast.success('Tag sheet ready', `${sheetTagCount(req)} tags, ${Math.round(req.tag_size_mm)} mm, ${req.page} ${req.orientation}.`);
    } catch (e) {
      toast.error('Could not generate the sheet', errorMessage(e));
    } finally {
      setPdfBusy(false);
    }
  };
  const save = async () => {
    if (!pdfBlob) return;
    const name = suggestedFilename(req);
    const b = bridge();
    if (b?.savePdf) {
      try {
        const path = await b.savePdf(await pdfBlob.arrayBuffer(), name);
        if (path) toast.success('PDF saved', path);
      } catch (e) {
        toast.error('Could not save the PDF', errorMessage(e));
      }
    } else downloadBlob(pdfBlob, name);
  };

  // Planner.
  const [plan, setPlan] = useState<TagPlanRequest>(DEFAULT_PLAN);
  const [planResult, setPlanResult] = useState<TagPlan | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const runPlan = async () => {
    setPlanBusy(true);
    try {
      setPlanResult(await api.tagPlan(plan));
    } catch (e) {
      toast.error('Planner failed', errorMessage(e));
    } finally {
      setPlanBusy(false);
    }
  };
  const applyPlan = () => {
    if (!planResult) return;
    setReq((r) => ({ ...r, count: Math.min(200, planResult.recommended_count), tag_size_mm: planResult.recommended_size_mm, family: planResult.family || r.family, page: (PAGE_SIZES.find((p) => p.id === planResult.page)?.id ?? r.page) }));
    toast.info('Plan applied to the sheet form');
  };

  const set = <K extends keyof TagSheetRequest>(k: K, v: TagSheetRequest[K]) => setReq((r) => ({ ...r, [k]: v }));
  const previewIds = sheetIds(req, 8);
  const area = printableArea(req);
  const tooBig = layout ? layout.fits === false : layoutError != null;

  return (
    <div>
      <PageHeader title="AprilTag printer" subtitle="Generate a PDF of tags at an exact physical size. The pipeline uses them for metric scale and a level floor." actions={<Link to="/guide#tags" className="btn-ghost">Where to place tags →</Link>} />
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(340px,420px)_1fr] gap-4 items-start">
        {/* Form */}
        <div className="space-y-4">
          <Panel title="Sheet">
            <div className="space-y-3">
              <Field label="Family" help={family?.description ?? 'tag36h11 is the standard family: 587 ids, robust at distance.'} error={errors.family}>
                {families.loading && !families.data ? (
                  <Skeleton className="h-8" />
                ) : (
                  <div className="space-y-1.5" role="radiogroup" aria-label="Tag family">
                    {(families.data ?? []).map((f) => (
                      <label key={f.name} className={cx('flex items-start gap-2 rounded-md border px-2.5 py-1.5 cursor-pointer', req.family === f.name ? 'border-accent bg-accent/10' : 'border-line hover:border-faint')}>
                        <input type="radio" name="family" className="mt-1" checked={req.family === f.name} onChange={() => set('family', f.name)} />
                        <span className="min-w-0">
                          <span className="font-mono text-xs">{f.name}</span>
                          {f.recommended && <span className="chip ml-2 text-ok border-ok/40 bg-ok/10">recommended</span>}
                          <span className="block text-2xs text-muted">
                            {f.ncodes} ids · {f.nbits} bits · hamming {f.hamming}
                          </span>
                        </span>
                      </label>
                    ))}
                    {families.error && <div className="text-2xs text-danger">Could not load families: {families.error}. Using {req.family}.</div>}
                  </div>
                )}
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="First id" error={errors.first_id} htmlFor="first-id">
                  <NumberInput id="first-id" value={req.first_id} min={0} step={1} onChange={(v) => set('first_id', v ?? 0)} disabled={!!req.ids?.length} />
                </Field>
                <Field label="Count" error={errors.count} htmlFor="count">
                  <NumberInput id="count" value={req.count} min={1} max={200} step={1} onChange={(v) => set('count', v ?? 1)} disabled={!!req.ids?.length} />
                </Field>
              </div>
              <Field label="Or explicit ids" help="Comma-separated or ranges, e.g. 0-7, 12, 20. Overrides first id / count." error={errors.ids} htmlFor="ids">
                <input
                  id="ids"
                  className="input font-mono"
                  value={idsText}
                  placeholder="leave empty to use first id + count"
                  onChange={(e) => {
                    setIdsText(e.target.value);
                    const r = parseIdList(e.target.value);
                    setIdsError(r.error);
                    if (!r.error) set('ids', r.ids);
                  }}
                />
              </Field>
              <Field label="Tag size (mm, black square edge)" help="200 mm for rooms, 300+ mm for halls and outdoors. Must match the project settings." error={errors.tag_size_mm} htmlFor="size">
                <NumberInput id="size" value={req.tag_size_mm} min={11} max={2000} step={5} onChange={(v) => set('tag_size_mm', v ?? 200)} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Page" htmlFor="page">
                  <select id="page" className="select" value={req.page} onChange={(e) => set('page', e.target.value as TagSheetRequest['page'])}>
                    {PAGE_SIZES.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Orientation" htmlFor="orient">
                  <select id="orient" className="select" value={req.orientation} onChange={(e) => set('orientation', e.target.value as TagSheetRequest['orientation'])}>
                    <option value="portrait">Portrait</option>
                    <option value="landscape">Landscape</option>
                  </select>
                </Field>
              </div>
              <Field label="Margin (mm)" error={errors.margin_mm} htmlFor="margin" help={`Printable area ≈ ${area.w.toFixed(0)} × ${area.h.toFixed(0)} mm`}>
                <NumberInput id="margin" value={req.margin_mm} min={0} max={50} step={1} onChange={(v) => set('margin_mm', v ?? 10)} />
              </Field>
              <Field label="Project name (printed on each tag)" error={errors.project_name} htmlFor="pname">
                <input id="pname" className="input" value={req.project_name ?? ''} placeholder="optional" onChange={(e) => set('project_name', e.target.value || null)} />
              </Field>
              <div className="grid grid-cols-1 gap-2">
                <Toggle checked={req.label} onChange={(v) => set('label', v)} label="Label each tag (id, family, size)" />
                <Toggle checked={req.include_guide} onChange={(v) => set('include_guide', v)} label="Include placement guide page" />
                <Toggle checked={req.include_scale_check} onChange={(v) => set('include_scale_check', v)} label="Include 100 mm scale check bar" />
              </div>
            </div>
          </Panel>

          <Panel title="Planner" actions={<Sparkles className="h-3.5 w-3.5 text-accent" />}>
            <p className="text-xs text-muted mb-3">Describe the space and get a recommended tag count, size and spacing.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Scene" htmlFor="scene">
                <select id="scene" className="select" value={plan.scene} onChange={(e) => setPlan({ ...plan, scene: e.target.value as TagPlanRequest['scene'] })}>
                  <option value="room">Single room</option>
                  <option value="multi_room">Several rooms</option>
                  <option value="outdoor">Outdoor</option>
                  <option value="object">Object</option>
                </select>
              </Field>
              <Field label="Area (m²)" htmlFor="area">
                <NumberInput id="area" value={plan.area_m2} min={2} max={5000} step={1} onChange={(v) => setPlan({ ...plan, area_m2: v ?? 50 })} />
              </Field>
              <Field label="Walk length (m)" htmlFor="walk">
                <NumberInput id="walk" value={plan.walk_length_m} min={2} max={1000} step={1} onChange={(v) => setPlan({ ...plan, walk_length_m: v ?? 20 })} />
              </Field>
              <Field label="Ceiling height (m)" htmlFor="ceil">
                <NumberInput id="ceil" value={plan.ceiling_height_m} min={1.1} max={30} step={0.1} onChange={(v) => setPlan({ ...plan, ceiling_height_m: v ?? 2.7 })} />
              </Field>
              <Field label="Printer max edge (mm)" htmlFor="pmax" help="279 for Letter, 297 for A4, 420 for A3.">
                <NumberInput id="pmax" value={plan.printer_max_mm} min={51} max={2000} step={1} onChange={(v) => setPlan({ ...plan, printer_max_mm: v ?? 279 })} />
              </Field>
              <div className="flex items-end">
                <button type="button" className="btn-secondary w-full justify-center" onClick={runPlan} disabled={planBusy}>
                  {planBusy ? <Spinner /> : <Sparkles className="h-4 w-4" />} Plan
                </button>
              </div>
            </div>
            {planResult && (
              <div className="mt-3 rounded-md border border-line bg-panel2 p-3 text-xs space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <div className="text-2xs uppercase text-muted">Tags</div>
                    <div className="text-sm font-semibold">{planResult.recommended_count}</div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase text-muted">Size</div>
                    <div className="text-sm font-semibold">{planResult.recommended_size_mm} mm</div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase text-muted">Spacing</div>
                    <div className="text-sm font-semibold">≈ {planResult.spacing_m.toFixed(1)} m</div>
                  </div>
                  <div>
                    <div className="text-2xs uppercase text-muted">Max view distance</div>
                    <div className="text-sm font-semibold">{planResult.max_view_distance_m.toFixed(1)} m</div>
                  </div>
                </div>
                <div className="text-muted">
                  Family <code className="code">{planResult.family}</code> on <code className="code">{planResult.page}</code>
                </div>
                {planResult.placement_tips.length > 0 && (
                  <ul className="list-disc pl-4 text-muted">
                    {planResult.placement_tips.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                )}
                {planResult.warnings.length > 0 && (
                  <Note kind="warning">
                    <ul className="list-disc pl-4">
                      {planResult.warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </Note>
                )}
                <button type="button" className="btn-primary btn-sm" onClick={applyPlan}>
                  Use these values
                </button>
              </div>
            )}
          </Panel>
        </div>

        {/* Preview and output */}
        <div className="space-y-4 min-w-0">
          <Panel
            title="Preview"
            actions={
              <span className="text-2xs text-muted">
                {sheetTagCount(req)} tag{sheetTagCount(req) === 1 ? '' : 's'} · {req.family} · {req.tag_size_mm} mm
              </span>
            }
          >
            <div className="flex flex-wrap gap-3">
              {previewIds.map((id) => (
                <figure key={id} className="w-24 text-center">
                  <img src={api.tagPngUrl(req.family, id, 240)} alt={`${req.family} id ${id}`} width={96} height={96} className="rounded border border-line bg-white" loading="lazy" onError={(e) => ((e.currentTarget.style.opacity = '0.3'))} />
                  <figcaption className="mt-1 font-mono text-2xs text-muted">id {id}</figcaption>
                </figure>
              ))}
              {sheetTagCount(req) > previewIds.length && <div className="w-24 grid place-items-center text-2xs text-faint">+{sheetTagCount(req) - previewIds.length} more</div>}
            </div>
            <div className="mt-4 rounded-md border border-line bg-panel2 p-3 text-xs">
              <div className="flex items-center gap-2 mb-2">
                <span className="panel-title">Layout</span>
                {layoutBusy && <Spinner className="h-3 w-3 animate-spin" />}
              </div>
              {!valid ? (
                <div className="text-danger">Fix the highlighted fields to preview the layout.</div>
              ) : layoutError ? (
                <Note kind="error">{layoutError}</Note>
              ) : layout ? (
                <div className="space-y-1.5">
                  {layout.fits === false && (
                    <Note kind="error">
                      {layout.message || 'The tag does not fit on this page.'} Largest size that fits: <strong>{layout.largest_fit_mm} mm</strong>.{' '}
                      <button type="button" className="underline" onClick={() => set('tag_size_mm', layout.largest_fit_mm)}>
                        Use {layout.largest_fit_mm} mm
                      </button>{' '}
                      or pick a larger page.
                    </Note>
                  )}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                    <div>
                      <div className="text-2xs uppercase text-muted">Pages</div>
                      <div className="font-semibold">
                        {layout.pages}
                        {layout.guide_pages ? <span className="text-faint font-normal"> (incl. {layout.guide_pages} guide)</span> : null}
                      </div>
                    </div>
                    <div>
                      <div className="text-2xs uppercase text-muted">Per page</div>
                      <div className="font-semibold">
                        {layout.tags_per_page} <span className="text-faint font-normal">({layout.grid[0]} × {layout.grid[1]})</span>
                      </div>
                    </div>
                    <div>
                      <div className="text-2xs uppercase text-muted">Cell / tag outer</div>
                      <div className="font-semibold">
                        {layout.cell_mm.toFixed(0)} / {layout.tag_outer_mm.toFixed(0)} mm
                      </div>
                    </div>
                    <div>
                      <div className="text-2xs uppercase text-muted">Largest fit</div>
                      <div className="font-semibold">{layout.largest_fit_mm} mm</div>
                    </div>
                  </div>
                  {layout.message && layout.fits !== false && <div className="text-muted">{layout.message}</div>}
                  {layout.mode && <div className="text-2xs text-faint">Mode: {layout.mode}. The tag outer size includes the white quiet zone the detector needs.</div>}
                </div>
              ) : (
                <Skeleton className="h-10" />
              )}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <button type="button" className="btn-primary" onClick={generate} disabled={!valid || pdfBusy || tooBig}>
                {pdfBusy ? <Spinner /> : <FileText className="h-4 w-4" />} Generate PDF
              </button>
              {pdfBlob && (
                <button type="button" className="btn-secondary" onClick={save}>
                  {isDesktop() ? <Save className="h-4 w-4" /> : <Download className="h-4 w-4" />} {isDesktop() ? 'Save…' : 'Download'}
                </button>
              )}
              {pdfUrl && (
                <a className="btn-ghost" href={pdfUrl} target="_blank" rel="noreferrer">
                  <Printer className="h-4 w-4" /> Open in a new tab
                </a>
              )}
            </div>
          </Panel>

          {pdfUrl && (
            <Panel title="PDF" bodyClassName="p-0">
              <iframe title="Tag sheet PDF" src={pdfUrl} className="w-full h-[640px] bg-white" />
            </Panel>
          )}

          <Panel title="Printing checklist">
            <ol className="list-decimal pl-5 text-[13px] leading-6 space-y-1">
              <li>
                Print at <strong>100 % / actual size</strong>. Turn off “fit to page”, “shrink to printable area” and any scaling in the print dialog.
              </li>
              <li>
                Put a ruler on the <strong>100 mm scale bar</strong>. If it does not measure 100 mm the printer scaled the page; fix the dialog and reprint. Measure one tag's black square too.
              </li>
              <li>Use <strong>matte paper</strong> (plain copier paper is fine). Glossy paper reflects lights and breaks detection.</li>
              <li>
                <strong>Mount flat</strong>: tape all four corners to the floor or wall; no curling, no folds across the tag. Foam board or cardboard backing helps on rough floors.
              </li>
              <li>Keep tags <strong>unobstructed</strong>: nothing on them, no feet or cables across them while you shoot, and spread them along the whole route.</li>
              <li>
                <strong>Note the size you printed.</strong> The app needs it: set <em>Printed tag size</em> to the measured black-square edge in the project's{' '}
                <Link to="/projects/new" className="text-accent underline">settings</Link> (Tags group). The family must match too.
              </li>
            </ol>
          </Panel>
        </div>
      </div>
    </div>
  );
}
