/**
 * Renders a Jev baseline (`path -> {categories, confidences, overall}`) plus the
 * run's {@link BaselineMeta} into an HTML report: a run-summary strip, per-category
 * scatter charts, and a per-file score table. Used by cli.ts's optional `--html`
 * output.
 *
 * `baseline` is the whole-project grey backdrop for every chart; `focus` (when
 * given) is the subset of paths drawn in colour — the files "in the change" — with
 * every other project file left grey. A null `focus` colours every file. Each chart
 * is a per-metric scatter (confidence × raw score); the per-file expand renders the
 * same charts with only that file coloured. Charts are drawn by Chart.js from a CDN,
 * so they need a browser with network; the cards and table are server-rendered.
 *
 * Confidence is a gate, not a weight: a score below `confidenceFloor` confidence is
 * "unsure" (slate) — the number can't be trusted, so a gating axis needs a human
 * sign-off (thresholds.ts). At or above the floor the raw score decides
 * fail/warn/pass. The report shows the raw score and marks the unsure ones, matching
 * the gate exactly.
 */
import type { Baseline, BaselineMeta, CategoryId } from './types.js';
import { ALL_CATEGORIES } from './types.js';

const CHARTJS_SRC = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js';
const DEFAULT_CONFIDENCE_FLOOR = 0.5;

const CAT_LABELS: Record<CategoryId, string> = {
  complexity_clean_code: 'Complexity',
  code_smells: 'Smells',
  testability: 'Testability',
  error_handling: 'Errors',
  security: 'Security',
  comments: 'Comments',
  concurrency_and_idempotency: 'Concurrency',
  ai_slop: 'AI slop',
};

const scoreZone = (v: number): string => (v < 1.5 ? 'fail' : v < 2.5 ? 'warn' : 'pass');
const overallZone = (v: number): string => (v < 2.0 ? 'fail' : v < 2.4 ? 'warn' : 'pass');
const fmt = (v: number | undefined): string => (v == null ? '–' : v.toFixed(2));
const pct = (v: number): number => Math.round((v / 4) * 100);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Display zone for a cell/point: no score → 'na'; confidence below the floor (or
 * missing) → 'unsure'; otherwise the raw score's zone. */
function zoneOf(score: number | undefined, confidence: number | undefined, floor: number): string {
  if (score == null) return 'na';
  if (confidence == null || confidence < floor) return 'unsure';
  return scoreZone(score);
}

function rawOverall(categories: Partial<Record<CategoryId, number>>): number {
  const vals: number[] = [];
  for (const k of ALL_CATEGORIES) {
    const s = categories[k];
    if (s != null) vals.push(s);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

const chipCell = (score: number | undefined, confidence: number | undefined, floor: number): string => {
  const zone = zoneOf(score, confidence, floor);
  const conf = confidence == null ? '–' : `${Math.round(confidence * 100)}%`;
  const title = score == null ? 'not scored' : zone === 'unsure' ? `unsure — ${score.toFixed(2)}/4, low confidence ${conf}` : `${score.toFixed(2)}/4 · confidence ${conf}`;
  const sub = score == null ? '' : `<span class="conf">${conf}</span>`;
  return `<td><span class="chip ${zone}" title="${title}">${fmt(score)}</span>${sub}</td>`;
};

const scatterCell = (k: CategoryId): string =>
  `<div class="scatter-cell"><div class="scatter-title">${CAT_LABELS[k]}</div><div class="chartbox"><canvas id="sc-${k}"></canvas></div></div>`;

export function renderBaselineHtml(
  baseline: Baseline,
  meta: BaselineMeta | null = null,
  focus: readonly string[] | null = null,
  confidenceFloor: number = DEFAULT_CONFIDENCE_FLOOR,
): string {
  const floor = confidenceFloor;
  const floorPct = Math.round(floor * 100);
  const rows = Object.entries(baseline).map(([path, e]) => ({
    path,
    categories: e.categories,
    confidences: e.confidences,
    overall: rawOverall(e.categories),
  }));
  const n = rows.length;
  const focusSet = focus == null ? null : new Set(focus);
  const tableRows = focusSet == null ? rows : rows.filter((r) => focusSet.has(r.path));
  const tn = tableRows.length;
  const meanOverall = tn ? tableRows.reduce((s, r) => s + r.overall, 0) / tn : 0;
  const catAverages = Object.fromEntries(
    ALL_CATEGORIES.map((k) => {
      const vals = tableRows.map((r) => r.categories[k]).filter((v): v is number => v != null);
      return [k, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0];
    }),
  ) as Record<CategoryId, number>;
  const confVals = tableRows.flatMap((r) => ALL_CATEGORIES.map((k) => r.confidences?.[k]).filter((v): v is number => typeof v === 'number'));
  const meanConfidence = confVals.length ? confVals.reduce((a, b) => a + b, 0) / confVals.length : null;

  // Bucket each file by its worst category cell (fail > unsure > warn > pass), so the
  // counts sum to the files scored and surface what needs attention.
  const buckets = { fail: 0, warn: 0, unsure: 0, pass: 0 };
  for (const r of tableRows) {
    let hasWarn = false;
    let hasUnsure = false;
    let hasFail = false;
    for (const k of ALL_CATEGORIES) {
      const z = zoneOf(r.categories[k], r.confidences?.[k], floor);
      if (z === 'fail') hasFail = true;
      else if (z === 'unsure') hasUnsure = true;
      else if (z === 'warn') hasWarn = true;
    }
    if (hasFail) buckets.fail++;
    else if (hasUnsure) buckets.unsure++;
    else if (hasWarn) buckets.warn++;
    else buckets.pass++;
  }

  const data = { rows, cats: ALL_CATEGORIES.map((k) => [k, CAT_LABELS[k]]), n, floorPct, focus: focus == null ? null : [...focus] };
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');

  const scatterCellsHtml = ALL_CATEGORIES.map((k) => scatterCell(k)).join('');

  const isChange = focusSet != null;
  const scoreCls = tn ? overallZone(meanOverall) : '';
  const heroFigure = tn ? `${pct(meanOverall)}<span class="denom">/100</span>` : '–';
  const subText = tn
    ? `${isChange ? `${tn} changed file${tn === 1 ? '' : 's'} of ${n} in project` : `${tn} file${tn === 1 ? '' : 's'} scored`} · mean ${meanOverall.toFixed(2)}/4`
    : 'Baseline is empty — run --write-baseline to populate it.';
  const scatterCaption = isChange
    ? `Per-category health: x = confidence (0–100%), y = raw score (0–4). Coloured = changed files, grey = the rest of the project. Slate = unsure (below ${floorPct}% confidence).`
    : `Per-category health: x = confidence (0–100%), y = raw score (0–4), one point per file. Slate = unsure (below ${floorPct}% confidence).`;

  const keyMetrics: [string, number, string][] = tn
    ? [
        ['Failing', buckets.fail, 'fail'],
        ['Warning', buckets.warn, 'warn'],
        ['Unsure', buckets.unsure, 'unsure'],
        ['Passing', buckets.pass, 'pass'],
      ]
    : [];
  const keyMetricsHtml = keyMetrics
    .map(([k, v, z]) => `<div class="km ${z}${v === 0 ? ' zero' : ''}"><div class="kmv">${v}</div><div class="kmk">${k}</div></div>`)
    .join('');

  const figures: [string, string | number, string][] = [];
  if (meta) {
    figures.push(['Duration', fmtDuration(meta.durationMs), `${meta.concurrency}× concurrency`]);
    figures.push(['API calls', meta.apiCalls, `${meta.filesScored} files`]);
    figures.push(['Cost', meta.totalCostUsd == null ? 'n/a' : `$${meta.totalCostUsd.toFixed(4)}`, meta.totalCostUsd == null ? 'provider silent' : '']);
    figures.push(['Input tokens', meta.totalInputTokens == null ? 'n/a' : meta.totalInputTokens.toLocaleString('en-US'), '']);
  }
  figures.push(['Mean confidence', meanConfidence == null ? 'n/a' : `${Math.round(meanConfidence * 100)}%`, meanConfidence == null ? 'no data' : '']);
  const runmetaHtml = figures
    .map(([k, v, s]) => `<div class="m"><div class="mk">${k}</div><div class="mv">${v}${s ? ` <small>${s}</small>` : ''}</div></div>`)
    .join('');

  const metaLine = meta
    ? `Scored ${esc(new Date(meta.generatedAt).toLocaleString())} · model ${esc(meta.model)} via ${esc(meta.provider)}`
    : 'Rendered from an existing baseline — no run metadata (duration, cost, API calls) available.';

  const headCols: [string, string][] = [['path', 'File'], ['overall', 'Overall'], ...ALL_CATEGORIES.map((k) => [k, CAT_LABELS[k]] as [string, string])];
  const headHtml = headCols
    .map(([k, l]) => `<th data-k="${k}">${l}<span class="arrow">${k === 'overall' ? ' ▲' : ''}</span></th>`)
    .join('');

  const sorted = [...tableRows].sort((a, b) => a.overall - b.overall);
  const bodyHtml = sorted
    .map((r) => {
      const cells = ALL_CATEGORIES.map((k) => chipCell(r.categories[k], r.confidences?.[k], floor)).join('');
      const ov = `<td><span class="chip overall ${overallZone(r.overall)}">${pct(r.overall)}</span></td>`;
      return `<tr class="filerow" data-path="${esc(r.path)}"><td><span class="caret">▸</span> ${esc(r.path)}</td>${ov}${cells}</tr>`;
    })
    .join('');

  const footHtml = tn
    ? `<td>Mean across ${tn} file${tn === 1 ? '' : 's'}</td><td><span class="chip overall ${overallZone(meanOverall)}">${pct(meanOverall)}</span></td>` +
      ALL_CATEGORIES.map((k) => `<td><span class="chip ${scoreZone(catAverages[k])}">${fmt(catAverages[k])}</span></td>`).join('')
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev Baseline</title>
<style>
  /* Paper tokens — mirrored from web/src/index.css (the app's authoritative source);
     keep in sync if the app palette moves. Light in :root, dark under both data-theme
     and prefers-color-scheme, exactly as the app scopes them. */
  :root {
    color-scheme: light;
    --hm-canvas:#edeeeb; --hm-surface:#ffffff; --hm-sunken:#f5f5f3; --hm-raised:#ededea;
    --hm-hairline:#e0e0db; --hm-edge:#d0d0ca; --hm-ink:#1b1e24; --hm-muted:#656b73; --hm-faint:#61676f;
    --hm-accent:#077067; --hm-accent-hot:#0a6f66; --hm-accent-tint:#b6ece4;
    --hm-running:#a74d08; --hm-running-tint:#fdeacc; --hm-done:#0d7734; --hm-done-tint:#d2f4db;
    --hm-fail:#b3253f; --hm-fail-tint:#ffccd6; --hm-blocked:#5b616a; --hm-blocked-tint:#ecedea;
    --hm-shadow-card:0 1px 2px rgb(27 30 36 / 0.06), 0 6px 18px rgb(27 30 36 / 0.07);
  }
  :root[data-theme="dark"] { color-scheme: dark;
    --hm-canvas:#141416; --hm-surface:#1e1f22; --hm-sunken:#141416; --hm-raised:#292a2e;
    --hm-hairline:#2f3035; --hm-edge:#414248; --hm-ink:#e9e9ec; --hm-muted:#a5a6ab; --hm-faint:#949599;
    --hm-accent:#2ed3c4; --hm-accent-hot:#5fe6da; --hm-accent-tint:#0f3e38;
    --hm-running:#ffb524; --hm-running-tint:#51360a; --hm-done:#2bf58e; --hm-done-tint:#0d5531;
    --hm-fail:#ff5570; --hm-fail-tint:#4d121f; --hm-blocked:#9aa0a9; --hm-blocked-tint:#292a2e;
    --hm-shadow-card:0 0 0 1px var(--hm-hairline), 0 2px 10px rgb(0 0 0 / 0.4);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { color-scheme: dark;
      --hm-canvas:#141416; --hm-surface:#1e1f22; --hm-sunken:#141416; --hm-raised:#292a2e;
      --hm-hairline:#2f3035; --hm-edge:#414248; --hm-ink:#e9e9ec; --hm-muted:#a5a6ab; --hm-faint:#949599;
      --hm-accent:#2ed3c4; --hm-accent-hot:#5fe6da; --hm-accent-tint:#0f3e38;
      --hm-running:#ffb524; --hm-running-tint:#51360a; --hm-done:#2bf58e; --hm-done-tint:#0d5531;
      --hm-fail:#ff5570; --hm-fail-tint:#4d121f; --hm-blocked:#9aa0a9; --hm-blocked-tint:#292a2e;
      --hm-shadow-card:0 0 0 1px var(--hm-hairline), 0 2px 10px rgb(0 0 0 / 0.4);
    }
  }
  /* Report-semantic aliases onto the Paper state family (var refs resolve per theme). */
  :root {
    --bg:var(--hm-canvas); --panel:var(--hm-surface); --ink:var(--hm-ink); --muted:var(--hm-muted);
    --faint:var(--hm-faint); --line:var(--hm-hairline); --accent:var(--hm-accent);
    --pass:var(--hm-done); --pass-bg:var(--hm-done-tint);
    --warn:var(--hm-running); --warn-bg:var(--hm-running-tint);
    --fail:var(--hm-fail); --fail-bg:var(--hm-fail-tint);
    --unsure:var(--hm-blocked); --unsure-bg:var(--hm-blocked-tint);
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; font-variant-numeric:tabular-nums; }
  .wrap { margin:0; padding:24px 24px 64px; }
  .report-head { display:flex; flex-wrap:wrap; align-items:flex-start; justify-content:space-between; gap:22px 44px; margin-bottom:26px; padding-bottom:20px; border-bottom:1px solid var(--line); }
  .verdict { display:flex; align-items:center; gap:18px; min-width:min(100%,300px); }
  .score { font-size:2.75rem; font-weight:800; line-height:1; letter-spacing:-0.03em; font-variant-numeric:tabular-nums; white-space:nowrap; flex:none; }
  .score .denom { font-size:1rem; font-weight:700; opacity:.5; letter-spacing:-0.01em; margin-left:1px; }
  .score.pass, .score.warn, .score.fail { background:none; }
  .score.pass { color:var(--pass); } .score.warn { color:var(--warn); } .score.fail { color:var(--fail); }
  .verdict-text { min-width:0; }
  h1 { font-size:1.0625rem; font-weight:700; margin:0 0 3px; letter-spacing:-0.01em; }
  .sub { color:var(--muted); font-size:13px; margin:0; }
  .keymetrics { display:flex; gap:30px; flex-wrap:wrap; align-content:flex-start; }
  .km.fail, .km.warn, .km.unsure, .km.pass { background:none; }
  .km .kmv { font-size:1.875rem; font-weight:800; line-height:1; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; }
  .km .kmk { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin-top:6px; }
  .km.fail .kmv { color:var(--fail); }
  .km.warn .kmv { color:var(--warn); }
  .km.unsure .kmv { color:var(--unsure); }
  .km.pass .kmv { color:var(--pass); }
  .km.zero .kmv { color:var(--faint); }
  .metaline { color:var(--faint); font-size:11.5px; margin:8px 0 0; }
  .runmeta { display:flex; flex-wrap:wrap; row-gap:14px; }
  .runmeta .m { padding:0 18px; border-left:1px solid var(--line); }
  .runmeta .m:first-child { padding-left:0; border-left:0; }
  .runmeta .mk { color:var(--muted); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.08em; }
  .runmeta .mv { font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; margin-top:4px; white-space:nowrap; }
  .runmeta .mv small { color:var(--muted); font-weight:400; font-size:11px; }
  .controls { display:flex; gap:12px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
  input[type=search]{ flex:1; min-width:200px; padding:9px 12px; border:1px solid var(--line); border-radius:3px; background:var(--panel); color:var(--ink); font-size:14px; }
  input[type=search]:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; border-color:var(--accent); }
  .hint { color:var(--muted); font-size:12px; }
  .tablewrap { overflow-x:auto; border-radius:4px; background:var(--panel); box-shadow:var(--hm-shadow-card); }
  table { border-collapse:collapse; width:100%; }
  th, td { padding:8px 10px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--line); vertical-align:top; }
  th:first-child, td:first-child { text-align:left; white-space:normal; word-break:break-all; min-width:260px; }
  thead th { position:sticky; top:0; background:var(--panel); cursor:pointer; user-select:none; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  thead th:hover { color:var(--ink); }
  th .arrow { opacity:.6; font-size:10px; }
  tbody tr:hover { background:color-mix(in srgb, var(--accent) 7%, transparent); }
  .chip { display:inline-block; min-width:44px; padding:2px 8px; border-radius:3px; font-variant-numeric:tabular-nums; font-weight:600; }
  .conf { display:block; margin-top:2px; font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .pass { color:var(--pass); background:var(--pass-bg); }
  .warn { color:var(--warn); background:var(--warn-bg); }
  .fail { color:var(--fail); background:var(--fail-bg); }
  .unsure { color:var(--unsure); background:var(--unsure-bg); }
  .na { color:var(--muted); }
  .overall { font-weight:700; }
  tfoot td { font-weight:600; color:var(--muted); border-top:2px solid var(--line); }
  .legend { display:flex; gap:14px; margin:14px 0 0; flex-wrap:wrap; color:var(--muted); font-size:12px; align-items:center; }
  .legend .chip { min-width:0; }
  .scatter-caption { color:var(--muted); font-size:12px; margin:0 0 8px; }
  .scatter-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(max(230px, calc((100% - 3 * 14px) / 4)),1fr)); gap:14px; margin-bottom:24px; }
  .scatter-cell { background:var(--panel); border-radius:4px; padding:10px 12px 12px; box-shadow:var(--hm-shadow-card); }
  .scatter-title { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; margin-bottom:6px; }
  .chartbox { position:relative; height:150px; }
  .chart-missing { grid-column:1/-1; color:var(--muted); font-size:13px; padding:16px; border:1px dashed var(--line); border-radius:4px; text-align:center; }
  tr.filerow { cursor:pointer; }
  .caret { display:inline-block; width:10px; color:var(--muted); }
  tr.detail-row td { background:var(--bg); border-bottom:1px solid var(--line); }
  .detail-charts { display:grid; grid-template-columns:repeat(auto-fit,minmax(max(180px, calc((100% - 3 * 12px) / 4)),1fr)); gap:12px; padding:12px 4px; white-space:normal; }
</style>
</head>
<body>
<div class="wrap">
  <header class="report-head">
    <div class="verdict">
      <div class="score ${scoreCls}">${heroFigure}</div>
      <div class="verdict-text">
        <h1>Jev code-quality ${isChange ? 'change report' : 'baseline'}</h1>
        <p class="sub" id="sub">${subText}</p>
        <p class="metaline" id="metaline">${metaLine}</p>
      </div>
    </div>
    <div class="keymetrics" id="keymetrics">${keyMetricsHtml}</div>
    <div class="runmeta" id="runmeta">${runmetaHtml}</div>
  </header>
  <p class="scatter-caption">${scatterCaption}</p>
  <div class="scatter-grid" id="scatterGrid">${scatterCellsHtml}</div>
  <div class="controls">
    <input type="search" id="filter" placeholder="Filter by path… (needs JavaScript)" autocomplete="off">
    <span class="hint" id="count">${tn} of ${tn} shown</span>
  </div>
  <div class="tablewrap">
    <table>
      <thead><tr id="head">${headHtml}</tr></thead>
      <tbody id="body">${bodyHtml}</tbody>
      <tfoot><tr id="foot">${footHtml}</tr></tfoot>
    </table>
  </div>
  <div class="legend">
    <span>Cells show the raw score (confidence on hover):</span>
    <span class="chip fail">&lt; 1.5 fail</span>
    <span class="chip warn">1.5–&lt;2.5 warn</span>
    <span class="chip pass">≥ 2.5 pass</span>
    <span class="chip unsure">&lt; ${floorPct}% conf · unsure</span>
    <span style="margin-left:12px">Overall (/100): fail &lt;50, warn &lt;60, pass ≥60</span>
  </div>
</div>
<script src="${CHARTJS_SRC}"></script>
<script type="application/json" id="data">${dataJson}</script>
<script>
  const D = JSON.parse(document.getElementById('data').textContent);
  const CATS = D.cats;
  const FLOOR = D.floorPct / 100;
  const FOCUS = D.focus ? new Set(D.focus) : null;
  const inFocus = (path) => FOCUS == null || FOCUS.has(path);
  const scoreZone = (v) => v < 1.5 ? 'fail' : v < 2.5 ? 'warn' : 'pass';
  const overallZone = (v) => v < 2.0 ? 'fail' : v < 2.4 ? 'warn' : 'pass';
  const zoneOf = (score, conf) => score == null ? 'na' : (conf == null || conf < FLOOR) ? 'unsure' : scoreZone(score);
  const fmt = (v) => v == null ? '–' : v.toFixed(2);
  const pct = (v) => Math.round((v / 4) * 100);
  const clamp = (c) => Math.max(0, Math.min(1, c));
  const rowOverall = (r) => {
    const vs = CATS.map(([k]) => r.categories[k]).filter(v => v != null);
    return vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : 0;
  };
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const hasChart = typeof Chart !== 'undefined';
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  // Read the --hm-* Paper tokens directly (they hold literal hex; the semantic
  // aliases hold var() refs that getPropertyValue would return unresolved).
  const palette = () => ({ pass: cssVar('--hm-done'), warn: cssVar('--hm-running'), fail: cssVar('--hm-fail'), unsure: cssVar('--hm-blocked'), na: cssVar('--hm-muted'), grid: cssVar('--hm-hairline'), tick: cssVar('--hm-muted'), panel: cssVar('--hm-surface'), passBg: cssVar('--hm-done-tint'), warnBg: cssVar('--hm-running-tint'), failBg: cssVar('--hm-fail-tint'), unsureBg: cssVar('--hm-blocked-tint') });
  const zoneColor = (P, z) => z === 'pass' ? P.pass : z === 'warn' ? P.warn : z === 'fail' ? P.fail : z === 'unsure' ? P.unsure : P.na;

  // Zone regions behind each plot, matching the gate: a vertical UNSURE band left of
  // the confidence floor (the score can't be trusted there), then horizontal
  // fail/warn/pass score bands on the confident right.
  const zoneBands = {
    id: 'zoneBands',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales: sc } = chart;
      if (!chartArea || !sc.x || !sc.y) return;
      const P = palette();
      const yTop = sc.y.getPixelForValue(4), yBot = sc.y.getPixelForValue(0);
      const xFloor = Math.max(chartArea.left, Math.min(chartArea.right, sc.x.getPixelForValue(FLOOR * 100)));
      const y15 = sc.y.getPixelForValue(1.5), y25 = sc.y.getPixelForValue(2.5);
      ctx.save();
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = P.unsureBg; ctx.fillRect(chartArea.left, yTop, xFloor - chartArea.left, yBot - yTop);
      const rx = xFloor, rw = chartArea.right - xFloor;
      ctx.fillStyle = P.passBg; ctx.fillRect(rx, yTop, rw, y25 - yTop);
      ctx.fillStyle = P.warnBg; ctx.fillRect(rx, y25, rw, y15 - y25);
      ctx.fillStyle = P.failBg; ctx.fillRect(rx, y15, rw, yBot - y15);
      ctx.restore();
    },
  };

  // Every project file's point for one category (the grey backdrop pool).
  function catPoints(k) {
    return D.rows.filter(r => r.categories[k] != null).map(r => {
      const s = r.categories[k];
      const c = r.confidences && r.confidences[k];
      return { x: c == null ? 0 : Math.round(clamp(c) * 100), y: s, zone: zoneOf(s, c), path: r.path, conf: c == null ? 'n/a' : Math.round(clamp(c) * 100) + '%' };
    });
  }
  function scales(P) {
    return {
      x: { min: 0, max: 100, ticks: { color: P.tick, font: { size: 9 }, stepSize: 25, callback: (v) => v + '%' }, grid: { color: P.grid } },
      y: { min: 0, max: 4, ticks: { color: P.tick, font: { size: 9 }, stepSize: 1 }, grid: { color: P.grid } },
    };
  }
  // One per-metric scatter: colour the points whose path passes \`colored\`, grey the rest.
  function metricChart(canvas, k, colored) {
    const P = palette();
    const pts = catPoints(k);
    const grey = [], color = [];
    for (const p of pts) (colored(p.path) ? color : grey).push(p);
    return new Chart(canvas, {
      type: 'scatter',
      data: { datasets: [
        { data: grey, pointRadius: 2.5, pointBackgroundColor: P.na + '4d', pointBorderWidth: 0, order: 2 },
        { data: color, pointRadius: 4.5, pointHoverRadius: 6.5, pointBackgroundColor: color.map(p => zoneColor(P, p.zone)), pointBorderColor: P.panel, pointBorderWidth: 1, order: 1 },
      ] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: { legend: { display: false }, tooltip: { displayColors: false, callbacks: { title: () => '', label: (ctx) => { const p = ctx.raw; return p.path + '  ' + p.y.toFixed(2) + '/4 · ' + p.conf; } } } },
        scales: scales(P),
      },
      plugins: [zoneBands],
    });
  }

  const overviewCharts = [];
  function buildOverview() {
    if (!hasChart) return;
    overviewCharts.forEach(c => c.destroy());
    overviewCharts.length = 0;
    for (const [k] of CATS) {
      const cv = document.getElementById('sc-' + k);
      if (cv) overviewCharts.push(metricChart(cv, k, inFocus));
    }
  }

  const detailCharts = [];
  function destroyDetailCharts() { detailCharts.forEach(c => c.destroy()); detailCharts.length = 0; }
  function buildDetail(root, path) {
    if (!hasChart) return;
    root.querySelectorAll('canvas[data-cat]').forEach((cv) => detailCharts.push(metricChart(cv, cv.dataset.cat, (p) => p === path)));
  }

  let sortKey = 'overall', sortDir = 1;
  const head = document.getElementById('head');
  function renderHead() {
    const cols = [['path','File'],['overall','Overall']].concat(CATS);
    head.innerHTML = cols.map(([k,l]) => {
      const arrow = k === sortKey ? (sortDir === 1 ? ' ▲' : ' ▼') : '';
      return '<th data-k="'+k+'">'+l+'<span class="arrow">'+arrow+'</span></th>';
    }).join('');
    head.querySelectorAll('th').forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (k === sortKey) sortDir *= -1; else { sortKey = k; sortDir = 1; }
      renderHead(); renderBody();
    });
  }
  const filterEl = document.getElementById('filter');
  const tableRows = FOCUS == null ? D.rows : D.rows.filter(r => FOCUS.has(r.path));
  function currentRows() {
    const q = filterEl.value.trim().toLowerCase();
    const rows = tableRows.filter(r => !q || r.path.toLowerCase().includes(q));
    rows.sort((a,b) => {
      if (sortKey === 'path') return sortDir * a.path.localeCompare(b.path);
      const av = sortKey === 'overall' ? rowOverall(a) : (a.categories[sortKey] ?? -1);
      const bv = sortKey === 'overall' ? rowOverall(b) : (b.categories[sortKey] ?? -1);
      return sortDir * (av - bv);
    });
    return rows;
  }
  const cell = (score, conf) => {
    const zone = zoneOf(score, conf);
    const c = conf == null ? '–' : Math.round(conf * 100) + '%';
    const title = score == null ? 'not scored' : zone === 'unsure' ? 'unsure — ' + score.toFixed(2) + '/4, low confidence ' + c : score.toFixed(2) + '/4 · confidence ' + c;
    const sub = score == null ? '' : '<span class="conf">' + c + '</span>';
    return '<td><span class="chip '+zone+'" title="'+title+'">'+fmt(score)+'</span>'+sub+'</td>';
  };
  const expanded = new Set();
  const body = document.getElementById('body');
  function renderBody() {
    destroyDetailCharts();
    const rows = currentRows();
    document.getElementById('count').textContent = rows.length + ' of ' + tableRows.length + ' shown';
    body.innerHTML = rows.map(r => {
      const cells = CATS.map(([k]) => cell(r.categories[k], r.confidences && r.confidences[k])).join('');
      const ov = '<td><span class="chip overall '+overallZone(rowOverall(r))+'">'+pct(rowOverall(r))+'</span></td>';
      const isOpen = expanded.has(r.path);
      const caret = '<span class="caret">'+(isOpen ? '▾' : '▸')+'</span> ';
      const mainRow = '<tr class="filerow" data-path="'+esc(r.path)+'"><td>'+caret+esc(r.path)+'</td>'+ov+cells+'</tr>';
      const detailCells = CATS.map(([k,l]) => '<div class="scatter-cell"><div class="scatter-title">'+l+'</div><div class="chartbox"><canvas data-cat="'+k+'"></canvas></div></div>').join('');
      const detail = isOpen
        ? '<tr class="detail-row" data-detail="'+esc(r.path)+'"><td colspan="'+(CATS.length+2)+'"><div class="detail-charts">'+detailCells+'</div></td></tr>'
        : '';
      return mainRow + detail;
    }).join('');
    body.querySelectorAll('tr.filerow').forEach((tr) => {
      tr.onclick = () => {
        const p = tr.dataset.path;
        if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
        renderBody();
      };
    });
    body.querySelectorAll('tr.detail-row').forEach((tr) => buildDetail(tr, tr.dataset.detail));
  }

  filterEl.placeholder = 'Filter by path…';
  if (!hasChart) {
    document.getElementById('scatterGrid').innerHTML = '<div class="chart-missing">Charts need a browser with network access to load Chart.js — the table below has the full data.</div>';
  }
  renderHead(); renderBody(); buildOverview();
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(() => { buildOverview(); renderBody(); });
</script>
</body>
</html>`;
}
