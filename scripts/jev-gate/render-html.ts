/**
 * Renders a Jev baseline (`path -> {categories, confidences, overall}`) plus the
 * run's {@link BaselineMeta} into an HTML report: a run-summary strip, per-category
 * scatter charts, and a per-file score table. Used by cli.ts's optional `--html`
 * output.
 *
 * Charts are drawn by Chart.js loaded from a CDN (jsDelivr), so the report needs a
 * browser with network access to render them. The cards, table and footer are still
 * rendered server-side, so the full data stays readable with no JavaScript and no
 * network — the charts are enhancement over that table, and a small notice replaces
 * the chart grid when Chart.js cannot load.
 *
 * Confidence shapes the display: each category cell shows the confidence-weighted
 * score (`score·c + 2·(1-c)` — Jev's raw score pulled toward the neutral 2.0 as it
 * grows less sure, see thresholds.ts `weightByConfidence`), and a file's overall is
 * the mean of its weighted category values. The raw score and confidence stay
 * visible (cell subtext + tooltip). The persisted baseline stores raw scores plus
 * confidences; the gate and ratchet judge the same weighted value (thresholds.ts),
 * so this display and the gate agree.
 */
import type { Baseline, BaselineMeta, CategoryId } from './types.js';
import { ALL_CATEGORIES } from './types.js';
import { NEUTRAL_SCORE, weightByConfidence } from './thresholds.js';

const CHARTJS_SRC = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js';
const DATALABELS_SRC = 'https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.2.0/dist/chartjs-plugin-datalabels.min.js';

const CAT_LABELS: Record<CategoryId, string> = {
  complexity_clean_code: 'Complexity',
  code_smells: 'Smells',
  duplication: 'Duplication',
  testability: 'Testability',
  error_handling: 'Errors',
  security: 'Security',
  comments: 'Comments',
  concurrency_and_idempotency: 'Concurrency',
};

/** Short tags for labelling this file's points on the per-file scatter. */
const CAT_SHORT: Record<CategoryId, string> = {
  complexity_clean_code: 'Cx',
  code_smells: 'Sm',
  duplication: 'Dup',
  testability: 'Test',
  error_handling: 'Err',
  security: 'Sec',
  comments: 'Com',
  concurrency_and_idempotency: 'Conc',
};

const catZone = (v: number | undefined): string => (v == null ? 'na' : v < 1.5 ? 'fail' : v < 2.5 ? 'warn' : 'pass');
const overallZone = (v: number): string => (v < 2.0 ? 'fail' : v < 2.4 ? 'warn' : 'pass');
const fmt = (v: number | undefined): string => (v == null ? '–' : v.toFixed(2));
const pct = (v: number): number => Math.round((v / 4) * 100);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function weighted(score: number | undefined, confidence: number | undefined): number | undefined {
  return score == null ? undefined : weightByConfidence(score, confidence);
}

function weightedOverall(categories: Partial<Record<CategoryId, number>>, confidences: Partial<Record<CategoryId, number>> | undefined): number {
  const vals: number[] = [];
  for (const k of ALL_CATEGORIES) {
    const w = weighted(categories[k], confidences?.[k]);
    if (w != null) vals.push(w);
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

const chipCell = (score: number | undefined, confidence: number | undefined): string => {
  const w = weighted(score, confidence);
  const conf = confidence == null ? '–' : `${Math.round(confidence * 100)}%`;
  const title = score == null ? 'not scored' : `raw ${score.toFixed(2)} · confidence ${conf}`;
  const sub = score == null ? '' : `<span class="conf">${conf}</span>`;
  return `<td><span class="chip ${catZone(w)}" title="${title}">${fmt(w)}</span>${sub}</td>`;
};

export function renderBaselineHtml(baseline: Baseline, meta: BaselineMeta | null = null): string {
  const rows = Object.entries(baseline).map(([path, e]) => ({
    path,
    categories: e.categories,
    confidences: e.confidences,
    overall: weightedOverall(e.categories, e.confidences),
  }));
  const n = rows.length;
  const meanOverall = n ? rows.reduce((s, r) => s + r.overall, 0) / n : 0;
  const catAverages = Object.fromEntries(
    ALL_CATEGORIES.map((k) => {
      const vals = rows.map((r) => weighted(r.categories[k], r.confidences?.[k])).filter((v): v is number => v != null);
      return [k, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0];
    }),
  ) as Record<CategoryId, number>;
  const confVals = rows.flatMap((r) => ALL_CATEGORIES.map((k) => r.confidences?.[k]).filter((v): v is number => typeof v === 'number'));
  const meanConfidence = confVals.length ? confVals.reduce((a, b) => a + b, 0) / confVals.length : null;

  const stats = {
    anyCatFail: rows.filter((r) => ALL_CATEGORIES.some((k) => catZone(weighted(r.categories[k], r.confidences?.[k])) === 'fail')).length,
    overallFail: rows.filter((r) => overallZone(r.overall) === 'fail').length,
    securityFail: rows.filter((r) => catZone(weighted(r.categories.security, r.confidences?.security)) === 'fail').length,
    commentsFail: rows.filter((r) => catZone(weighted(r.categories.comments, r.confidences?.comments)) === 'fail').length,
  };

  const catShort = Object.fromEntries(ALL_CATEGORIES.map((k) => [k, CAT_SHORT[k]])) as Record<CategoryId, string>;
  const data = { rows, cats: ALL_CATEGORIES.map((k) => [k, CAT_LABELS[k]]), catShort, meanOverall, n, catAverages, stats, neutral: NEUTRAL_SCORE };
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');

  const scatterCellsHtml = ALL_CATEGORIES.map(
    (k) => `<div class="scatter-cell"><div class="scatter-title">${CAT_LABELS[k]}</div><div class="chartbox"><canvas id="sc-${k}"></canvas></div></div>`,
  ).join('');

  const subText = n
    ? `${n} files scored · mean overall ${pct(meanOverall)}/100 (${meanOverall.toFixed(2)}/4, confidence-weighted)`
    : 'Baseline is empty — run --write-baseline to populate it.';

  const cards: [string, string | number, string][] = [];
  if (meta) {
    cards.push(['Duration', fmtDuration(meta.durationMs), `${meta.concurrency}× concurrency`]);
    cards.push(['API calls', meta.apiCalls, `${meta.filesScored} files`]);
    cards.push(['Cost', meta.totalCostUsd == null ? 'n/a' : `$${meta.totalCostUsd.toFixed(4)}`, meta.totalCostUsd == null ? 'provider silent' : 'this run']);
    cards.push(['Input tokens', meta.totalInputTokens == null ? 'n/a' : meta.totalInputTokens.toLocaleString('en-US'), meta.totalInputTokens == null ? 'provider silent' : '']);
  }
  cards.push(['Files scored', n, '']);
  cards.push(['Mean overall', `${pct(meanOverall)}/100`, `${meanOverall.toFixed(2)}/4`]);
  cards.push(['Mean confidence', meanConfidence == null ? 'n/a' : `${Math.round(meanConfidence * 100)}%`, meanConfidence == null ? 'no confidence data' : '']);
  cards.push(['Any category FAIL', stats.anyCatFail, `of ${n}`]);
  cards.push(['Overall FAIL (<50)', stats.overallFail, `of ${n}`]);
  cards.push(['Security FAIL', stats.securityFail, 'advisory']);
  const cardsHtml = cards
    .map(([k, v, s]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}${s ? ` <small>${s}</small>` : ''}</div></div>`)
    .join('');

  const metaLine = meta
    ? `Scored ${esc(new Date(meta.generatedAt).toLocaleString())} · model ${esc(meta.model)} via ${esc(meta.provider)}`
    : 'Rendered from an existing baseline — no run metadata (duration, cost, API calls) available.';

  const headCols: [string, string][] = [['path', 'File'], ['overall', 'Overall'], ...ALL_CATEGORIES.map((k) => [k, CAT_LABELS[k]] as [string, string])];
  const headHtml = headCols
    .map(([k, l]) => `<th data-k="${k}">${l}<span class="arrow">${k === 'overall' ? ' ▲' : ''}</span></th>`)
    .join('');

  // Default view: worst-first by overall (most actionable), matching the client's default sort.
  const sorted = [...rows].sort((a, b) => a.overall - b.overall);
  const bodyHtml = sorted
    .map((r) => {
      const cells = ALL_CATEGORIES.map((k) => chipCell(r.categories[k], r.confidences?.[k])).join('');
      const ov = `<td><span class="chip overall ${overallZone(r.overall)}">${pct(r.overall)}</span></td>`;
      return `<tr class="filerow" data-path="${esc(r.path)}"><td><span class="caret">▸</span> ${esc(r.path)}</td>${ov}${cells}</tr>`;
    })
    .join('');

  const footHtml = n
    ? `<td>Mean across ${n} files</td><td><span class="chip overall ${overallZone(meanOverall)}">${pct(meanOverall)}</span></td>` +
      ALL_CATEGORIES.map((k) => `<td><span class="chip ${catZone(catAverages[k])}">${fmt(catAverages[k])}</span></td>`).join('')
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev Baseline</title>
<style>
  :root {
    --bg:#f7f8fa; --panel:#fff; --ink:#1a1d23; --muted:#6b7280; --line:#e5e7eb;
    --pass:#128a4d; --pass-bg:#e5f6ec; --warn:#9a6700; --warn-bg:#fdf3d7; --fail:#b3261e; --fail-bg:#fce8e6; --accent:#2f6feb;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --bg:#0f1216; --panel:#171b21; --ink:#e6e8eb; --muted:#9aa3ae; --line:#2a303a;
      --pass:#4ec98a; --pass-bg:#122a1e; --warn:#e0b341; --warn-bg:#2c2410; --fail:#f28b82; --fail-bg:#2c1614; --accent:#6ea0ff;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1200px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--muted); margin:0 0 4px; }
  .metaline { color:var(--muted); font-size:12px; margin:0 0 20px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:24px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  .card .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  .card .v { font-size:24px; font-weight:600; margin-top:4px; }
  .card .v small { font-size:13px; font-weight:400; color:var(--muted); }
  .controls { display:flex; gap:12px; align-items:center; margin-bottom:12px; flex-wrap:wrap; }
  input[type=search]{ flex:1; min-width:200px; padding:9px 12px; border:1px solid var(--line); border-radius:8px; background:var(--panel); color:var(--ink); font-size:14px; }
  .hint { color:var(--muted); font-size:12px; }
  .tablewrap { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--panel); }
  table { border-collapse:collapse; width:100%; }
  th, td { padding:8px 10px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--line); vertical-align:top; }
  th:first-child, td:first-child { text-align:left; white-space:normal; word-break:break-all; min-width:260px; }
  thead th { position:sticky; top:0; background:var(--panel); cursor:pointer; user-select:none; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  thead th:hover { color:var(--ink); }
  th .arrow { opacity:.6; font-size:10px; }
  tbody tr:hover { background:color-mix(in srgb, var(--accent) 7%, transparent); }
  .chip { display:inline-block; min-width:44px; padding:2px 8px; border-radius:6px; font-variant-numeric:tabular-nums; font-weight:600; }
  .conf { display:block; margin-top:2px; font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .pass { color:var(--pass); background:var(--pass-bg); }
  .warn { color:var(--warn); background:var(--warn-bg); }
  .fail { color:var(--fail); background:var(--fail-bg); }
  .na { color:var(--muted); }
  .overall { font-weight:700; }
  tfoot td { font-weight:600; color:var(--muted); border-top:2px solid var(--line); }
  .legend { display:flex; gap:14px; margin:14px 0 0; flex-wrap:wrap; color:var(--muted); font-size:12px; align-items:center; }
  .legend .chip { min-width:0; }
  .scatter-caption { color:var(--muted); font-size:12px; margin:0 0 8px; }
  .scatter-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:14px; margin-bottom:24px; }
  .scatter-cell { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 12px 12px; }
  .scatter-title { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; margin-bottom:6px; }
  .chartbox { position:relative; height:170px; }
  .chart-missing { grid-column:1/-1; color:var(--muted); font-size:13px; padding:16px; border:1px dashed var(--line); border-radius:10px; text-align:center; }
  tr.filerow { cursor:pointer; }
  .caret { display:inline-block; width:10px; color:var(--muted); }
  tr.detail-row td { background:var(--bg); border-bottom:1px solid var(--line); }
  .detail-panel { padding:12px 4px; display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap; white-space:normal; }
  .detail-chartbox { position:relative; height:300px; width:min(520px,100%); flex:1 1 360px; }
  .detail-hint { color:var(--muted); font-size:11px; max-width:220px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Jev code-quality baseline</h1>
  <p class="sub" id="sub">${subText}</p>
  <p class="metaline" id="metaline">${metaLine}</p>
  <div class="cards" id="cards">${cardsHtml}</div>
  <p class="scatter-caption">Per-category health: x = confidence (0–100%), y = raw score (0–4), one point per file.</p>
  <div class="scatter-grid" id="scatterGrid">${scatterCellsHtml}</div>
  <div class="controls">
    <input type="search" id="filter" placeholder="Filter by path… (needs JavaScript)" autocomplete="off">
    <span class="hint" id="count">${n} of ${n} shown</span>
  </div>
  <div class="tablewrap">
    <table>
      <thead><tr id="head">${headHtml}</tr></thead>
      <tbody id="body">${bodyHtml}</tbody>
      <tfoot><tr id="foot">${footHtml}</tr></tfoot>
    </table>
  </div>
  <div class="legend">
    <span>Cells show the confidence-weighted score (raw · confidence on hover):</span>
    <span class="chip fail">&lt; 1.5 fail</span>
    <span class="chip warn">1.5–&lt;2.5 warn</span>
    <span class="chip pass">≥ 2.5 pass</span>
    <span style="margin-left:12px">Overall (/100): fail &lt;50, warn &lt;60, pass ≥60</span>
    <span style="margin-left:12px">Weighting: score·c + ${NEUTRAL_SCORE.toFixed(1)}·(1−c), c = confidence</span>
  </div>
</div>
<script src="${CHARTJS_SRC}"></script>
<script src="${DATALABELS_SRC}"></script>
<script type="application/json" id="data">${dataJson}</script>
<script>
  const D = JSON.parse(document.getElementById('data').textContent);
  const CATS = D.cats;
  const NEUTRAL = D.neutral;
  const catZone = (v) => v == null ? 'na' : v < 1.5 ? 'fail' : v < 2.5 ? 'warn' : 'pass';
  const overallZone = (v) => v < 2.0 ? 'fail' : v < 2.4 ? 'warn' : 'pass';
  const fmt = (v) => v == null ? '–' : v.toFixed(2);
  const pct = (v) => Math.round((v / 4) * 100);
  const clamp = (c) => Math.max(0, Math.min(1, c));
  const weight = (score, conf) => score == null ? null : (conf == null ? score : score * clamp(conf) + NEUTRAL * (1 - clamp(conf)));
  const rowOverall = (r) => {
    const vs = CATS.map(([k]) => weight(r.categories[k], r.confidences && r.confidences[k])).filter(v => v != null);
    return vs.length ? vs.reduce((a,b)=>a+b,0)/vs.length : 0;
  };
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  // ---- Chart.js scatter charts (CDN) ----
  const hasChart = typeof Chart !== 'undefined';
  const hasDL = typeof ChartDataLabels !== 'undefined';
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const palette = () => ({ pass: cssVar('--pass'), warn: cssVar('--warn'), fail: cssVar('--fail'), na: cssVar('--muted'), grid: cssVar('--line'), tick: cssVar('--muted'), ink: cssVar('--ink') });
  const zoneColor = (P, z) => z === 'pass' ? P.pass : z === 'warn' ? P.warn : z === 'fail' ? P.fail : P.na;

  function catPoints(k) {
    return D.rows.filter(r => r.categories[k] != null).map(r => {
      const score = r.categories[k];
      const conf = r.confidences && r.confidences[k];
      const known = conf != null;
      return { x: known ? Math.round(clamp(conf) * 100) : 100, y: score, zone: known ? catZone(weight(score, conf)) : 'na', path: r.path, conf: known ? Math.round(clamp(conf) * 100) + '%' : 'n/a' };
    });
  }
  function scales(P, axisLabels) {
    return {
      x: { min: 0, max: 100, ...(axisLabels ? { title: { display: true, text: 'confidence %', color: P.tick, font: { size: 10 } } } : {}), ticks: { color: P.tick, font: { size: 9 }, stepSize: 25, callback: (v) => v + '%' }, grid: { color: P.grid } },
      y: { min: 0, max: 4, ...(axisLabels ? { title: { display: true, text: 'score', color: P.tick, font: { size: 10 } } } : {}), ticks: { color: P.tick, font: { size: 9 }, stepSize: 1 }, grid: { color: P.grid } },
    };
  }

  const overviewCharts = [];
  function buildOverview() {
    if (!hasChart) return;
    const P = palette();
    overviewCharts.forEach(c => c.destroy());
    overviewCharts.length = 0;
    for (const [k] of CATS) {
      const cv = document.getElementById('sc-' + k);
      if (!cv) continue;
      const pts = catPoints(k);
      overviewCharts.push(new Chart(cv, {
        type: 'scatter',
        data: { datasets: [{ data: pts, pointRadius: 3.5, pointHoverRadius: 6, pointBackgroundColor: pts.map(p => zoneColor(P, p.zone)), pointBorderColor: cssVar('--panel'), pointBorderWidth: 1 }] },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          plugins: { legend: { display: false }, tooltip: { displayColors: false, callbacks: { title: () => '', label: (ctx) => { const p = ctx.raw; return p.path + '  ' + p.y.toFixed(2) + '/4 · ' + p.conf; } } } },
          scales: scales(P, false),
        },
      }));
    }
  }

  const detailCharts = new Map();
  function destroyDetailCharts() { detailCharts.forEach(c => c.destroy()); detailCharts.clear(); }
  function cloudPoints() {
    const pts = [];
    for (const r of D.rows) for (const [k] of CATS) {
      const s = r.categories[k];
      if (s == null) continue;
      const c = r.confidences && r.confidences[k];
      pts.push({ x: c == null ? 100 : Math.round(clamp(c) * 100), y: s });
    }
    return pts;
  }
  function buildDetail(path, cv) {
    if (!hasChart) return;
    const P = palette();
    const row = D.rows.find(r => r.path === path);
    if (!row) return;
    const filePts = CATS.map(([k, label]) => {
      const s = row.categories[k];
      if (s == null) return null;
      const c = row.confidences && row.confidences[k];
      const known = c != null;
      return { x: known ? Math.round(clamp(c) * 100) : 100, y: s, zone: known ? catZone(weight(s, c)) : 'na', tag: D.catShort[k], label, conf: known ? Math.round(clamp(c) * 100) + '%' : 'n/a' };
    }).filter(Boolean);
    detailCharts.set(path, new Chart(cv, {
      type: 'scatter',
      data: { datasets: [
        { label: 'all files', data: cloudPoints(), pointRadius: 2.5, pointBackgroundColor: P.na + '2e', pointBorderWidth: 0, order: 2 },
        { label: 'this file', data: filePts, pointRadius: 7, pointHoverRadius: 9, pointBackgroundColor: filePts.map(p => zoneColor(P, p.zone)), pointBorderColor: cssVar('--panel'), pointBorderWidth: 1.5, order: 1 },
      ] },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        plugins: {
          legend: { display: false },
          tooltip: { displayColors: false, filter: (ctx) => ctx.datasetIndex === 1, callbacks: { title: () => '', label: (ctx) => { const p = ctx.raw; return p.label + '  ' + p.y.toFixed(2) + '/4 · ' + p.conf; } } },
          datalabels: hasDL ? { display: (ctx) => ctx.datasetIndex === 1, color: P.ink, font: { size: 10, weight: 'bold' }, align: 'right', offset: 5, formatter: (v) => v.tag } : undefined,
        },
        scales: scales(P, true),
      },
      plugins: hasDL ? [ChartDataLabels] : [],
    }));
  }

  // ---- table: sort, filter, expand ----
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
  function currentRows() {
    const q = filterEl.value.trim().toLowerCase();
    const rows = D.rows.filter(r => !q || r.path.toLowerCase().includes(q));
    rows.sort((a,b) => {
      if (sortKey === 'path') return sortDir * a.path.localeCompare(b.path);
      const av = sortKey === 'overall' ? rowOverall(a) : (weight(a.categories[sortKey], a.confidences && a.confidences[sortKey]) ?? -1);
      const bv = sortKey === 'overall' ? rowOverall(b) : (weight(b.categories[sortKey], b.confidences && b.confidences[sortKey]) ?? -1);
      return sortDir * (av - bv);
    });
    return rows;
  }
  const cell = (score, conf) => {
    const w = weight(score, conf);
    const c = conf == null ? '–' : Math.round(conf * 100) + '%';
    const title = score == null ? 'not scored' : 'raw ' + score.toFixed(2) + ' · confidence ' + c;
    const sub = score == null ? '' : '<span class="conf">' + c + '</span>';
    return '<td><span class="chip '+catZone(w)+'" title="'+title+'">'+fmt(w)+'</span>'+sub+'</td>';
  };
  const expanded = new Set();
  const body = document.getElementById('body');
  function renderBody() {
    destroyDetailCharts();
    const rows = currentRows();
    document.getElementById('count').textContent = rows.length + ' of ' + D.n + ' shown';
    body.innerHTML = rows.map(r => {
      const cells = CATS.map(([k]) => cell(r.categories[k], r.confidences && r.confidences[k])).join('');
      const ov = '<td><span class="chip overall '+overallZone(rowOverall(r))+'">'+pct(rowOverall(r))+'</span></td>';
      const isOpen = expanded.has(r.path);
      const caret = '<span class="caret">'+(isOpen ? '▾' : '▸')+'</span> ';
      const mainRow = '<tr class="filerow" data-path="'+esc(r.path)+'"><td>'+caret+esc(r.path)+'</td>'+ov+cells+'</tr>';
      const detail = isOpen
        ? '<tr class="detail-row"><td colspan="'+(CATS.length+2)+'"><div class="detail-panel"><div class="detail-chartbox"><canvas data-detail="'+esc(r.path)+'"></canvas></div>'
          + '<p class="detail-hint">Labelled points: this file’s '+CATS.length+' categories. Faint cloud: every file × category, for context.</p></div></td></tr>'
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
    body.querySelectorAll('canvas[data-detail]').forEach((cv) => buildDetail(cv.dataset.detail, cv));
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
