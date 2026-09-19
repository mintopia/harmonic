/**
 * Renders a Jev baseline (`path -> {categories, confidences, overall}`) plus the
 * run's {@link BaselineMeta} into an HTML report: a run-summary strip, per-category
 * scatter charts, and a per-file score table. Used by cli.ts's optional `--html`
 * output.
 *
 * `baseline` is the whole-project grey backdrop for every chart; `focus` (when
 * given) is the subset of paths drawn in colour — the files "in the change" — with
 * every other project file left grey. A null `focus` colours every file (a plain
 * whole-project render). Each chart is a per-metric scatter (confidence × raw
 * score); the per-file expand renders the same eight charts with only that file
 * coloured. Charts are drawn by Chart.js from a CDN, so they need a browser with
 * network; the cards and table are server-rendered and stay readable without it.
 *
 * Confidence shapes the display: each category cell shows the confidence-weighted
 * score (`score·c + 2·(1-c)` — see thresholds.ts `weightByConfidence`), and a
 * file's overall is the mean of its weighted category values. The persisted
 * baseline stores raw scores plus confidences; the gate and ratchet judge the same
 * weighted value, so this display and the gate agree.
 */
import type { Baseline, BaselineMeta, CategoryId } from './types.js';
import { ALL_CATEGORIES } from './types.js';
import { NEUTRAL_SCORE, weightByConfidence } from './thresholds.js';

const CHARTJS_SRC = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js';

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

const scatterCell = (k: CategoryId, idPrefix: string): string =>
  `<div class="scatter-cell"><div class="scatter-title">${CAT_LABELS[k]}</div><div class="chartbox"><canvas id="${idPrefix}-${k}"></canvas></div></div>`;

export function renderBaselineHtml(baseline: Baseline, meta: BaselineMeta | null = null, focus: readonly string[] | null = null): string {
  const rows = Object.entries(baseline).map(([path, e]) => ({
    path,
    categories: e.categories,
    confidences: e.confidences,
    overall: weightedOverall(e.categories, e.confidences),
  }));
  const n = rows.length;
  // The score table and its rollups show the focus set when there is one (the
  // change), otherwise the whole project; the charts always keep the full
  // project as their grey backdrop.
  const focusSet = focus == null ? null : new Set(focus);
  const tableRows = focusSet == null ? rows : rows.filter((r) => focusSet.has(r.path));
  const tn = tableRows.length;
  const meanOverall = tn ? tableRows.reduce((s, r) => s + r.overall, 0) / tn : 0;
  const catAverages = Object.fromEntries(
    ALL_CATEGORIES.map((k) => {
      const vals = tableRows.map((r) => weighted(r.categories[k], r.confidences?.[k])).filter((v): v is number => v != null);
      return [k, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0];
    }),
  ) as Record<CategoryId, number>;
  const confVals = tableRows.flatMap((r) => ALL_CATEGORIES.map((k) => r.confidences?.[k]).filter((v): v is number => typeof v === 'number'));
  const meanConfidence = confVals.length ? confVals.reduce((a, b) => a + b, 0) / confVals.length : null;

  const stats = {
    anyCatFail: tableRows.filter((r) => ALL_CATEGORIES.some((k) => catZone(weighted(r.categories[k], r.confidences?.[k])) === 'fail')).length,
    overallFail: tableRows.filter((r) => overallZone(r.overall) === 'fail').length,
    securityFail: tableRows.filter((r) => catZone(weighted(r.categories.security, r.confidences?.security)) === 'fail').length,
  };

  const data = { rows, cats: ALL_CATEGORIES.map((k) => [k, CAT_LABELS[k]]), n, neutral: NEUTRAL_SCORE, focus: focus == null ? null : [...focus] };
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');

  const scatterCellsHtml = ALL_CATEGORIES.map((k) => scatterCell(k, 'sc')).join('');

  const isChange = focusSet != null;
  const subText = tn
    ? `${tn}${isChange ? ` changed file${tn === 1 ? '' : 's'} of ${n} in project` : ' files'} scored · mean overall ${pct(meanOverall)}/100 (${meanOverall.toFixed(2)}/4, confidence-weighted)`
    : 'Baseline is empty — run --write-baseline to populate it.';
  const scatterCaption = isChange
    ? 'Per-category health: x = confidence (0–100%), y = raw score (0–4). Coloured = changed files, grey = the rest of the project.'
    : 'Per-category health: x = confidence (0–100%), y = raw score (0–4), one point per file.';

  const cards: [string, string | number, string][] = [];
  if (meta) {
    cards.push(['Duration', fmtDuration(meta.durationMs), `${meta.concurrency}× concurrency`]);
    cards.push(['API calls', meta.apiCalls, `${meta.filesScored} files`]);
    cards.push(['Cost', meta.totalCostUsd == null ? 'n/a' : `$${meta.totalCostUsd.toFixed(4)}`, meta.totalCostUsd == null ? 'provider silent' : 'this run']);
    cards.push(['Input tokens', meta.totalInputTokens == null ? 'n/a' : meta.totalInputTokens.toLocaleString('en-US'), meta.totalInputTokens == null ? 'provider silent' : '']);
  }
  cards.push([isChange ? 'Changed files' : 'Files scored', tn, isChange ? `of ${n} in project` : '']);
  cards.push(['Mean overall', `${pct(meanOverall)}/100`, `${meanOverall.toFixed(2)}/4`]);
  cards.push(['Mean confidence', meanConfidence == null ? 'n/a' : `${Math.round(meanConfidence * 100)}%`, meanConfidence == null ? 'no confidence data' : '']);
  cards.push(['Any category FAIL', stats.anyCatFail, `of ${tn}`]);
  cards.push(['Overall FAIL (<50)', stats.overallFail, `of ${tn}`]);
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

  const sorted = [...tableRows].sort((a, b) => a.overall - b.overall);
  const bodyHtml = sorted
    .map((r) => {
      const cells = ALL_CATEGORIES.map((k) => chipCell(r.categories[k], r.confidences?.[k])).join('');
      const ov = `<td><span class="chip overall ${overallZone(r.overall)}">${pct(r.overall)}</span></td>`;
      return `<tr class="filerow" data-path="${esc(r.path)}"><td><span class="caret">▸</span> ${esc(r.path)}</td>${ov}${cells}</tr>`;
    })
    .join('');

  const footHtml = tn
    ? `<td>Mean across ${tn} file${tn === 1 ? '' : 's'}</td><td><span class="chip overall ${overallZone(meanOverall)}">${pct(meanOverall)}</span></td>` +
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
  .wrap { margin:0; padding:24px 24px 64px; }
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
  .scatter-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(max(230px, calc((100% - 3 * 14px) / 4)),1fr)); gap:14px; margin-bottom:24px; }
  .scatter-cell { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px 12px 12px; }
  .scatter-title { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; margin-bottom:6px; }
  .chartbox { position:relative; height:150px; }
  .chart-missing { grid-column:1/-1; color:var(--muted); font-size:13px; padding:16px; border:1px dashed var(--line); border-radius:10px; text-align:center; }
  tr.filerow { cursor:pointer; }
  .caret { display:inline-block; width:10px; color:var(--muted); }
  tr.detail-row td { background:var(--bg); border-bottom:1px solid var(--line); }
  .detail-charts { display:grid; grid-template-columns:repeat(auto-fit,minmax(max(180px, calc((100% - 3 * 12px) / 4)),1fr)); gap:12px; padding:12px 4px; white-space:normal; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Jev code-quality baseline</h1>
  <p class="sub" id="sub">${subText}</p>
  <p class="metaline" id="metaline">${metaLine}</p>
  <div class="cards" id="cards">${cardsHtml}</div>
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
    <span>Cells show the confidence-weighted score (raw · confidence on hover):</span>
    <span class="chip fail">&lt; 1.5 fail</span>
    <span class="chip warn">1.5–&lt;2.5 warn</span>
    <span class="chip pass">≥ 2.5 pass</span>
    <span style="margin-left:12px">Overall (/100): fail &lt;50, warn &lt;60, pass ≥60</span>
    <span style="margin-left:12px">Weighting: score·c + ${NEUTRAL_SCORE.toFixed(1)}·(1−c), c = confidence</span>
  </div>
</div>
<script src="${CHARTJS_SRC}"></script>
<script type="application/json" id="data">${dataJson}</script>
<script>
  const D = JSON.parse(document.getElementById('data').textContent);
  const CATS = D.cats;
  const NEUTRAL = D.neutral;
  const FOCUS = D.focus ? new Set(D.focus) : null;
  const inFocus = (path) => FOCUS == null || FOCUS.has(path);
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

  const hasChart = typeof Chart !== 'undefined';
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const palette = () => ({ pass: cssVar('--pass'), warn: cssVar('--warn'), fail: cssVar('--fail'), na: cssVar('--muted'), grid: cssVar('--line'), tick: cssVar('--muted'), panel: cssVar('--panel'), passBg: cssVar('--pass-bg'), warnBg: cssVar('--warn-bg'), failBg: cssVar('--fail-bg') });
  const zoneColor = (P, z) => z === 'pass' ? P.pass : z === 'warn' ? P.warn : z === 'fail' ? P.fail : P.na;

  // fail/warn/pass zones behind each plot, in the SAME confidence×score space the
  // dots live in: a point's zone is catZone(weight(score, conf)), so the boundaries
  // are the curves where weight = 1.5 and 2.5 — i.e. score = 2 ± 0.5/confidence.
  // Low confidence (left) is all neutral/warn; the pass/fail regions only open up
  // as confidence rises (right). Rasterised in thin vertical strips.
  const zoneBands = {
    id: 'zoneBands',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales: sc } = chart;
      if (!chartArea || !sc.x || !sc.y) return;
      const P = palette();
      const yTop = sc.y.getPixelForValue(4), yBot = sc.y.getPixelForValue(0);
      const step = 2;
      ctx.save();
      ctx.globalAlpha = 0.5;
      for (let px = chartArea.left; px < chartArea.right; px += step) {
        const c = Math.max(0, Math.min(1, sc.x.getValueForPixel(px) / 100));
        const sHi = c <= 0 ? 4 : Math.min(4, 2 + 0.5 / c);
        const sLo = c <= 0 ? 0 : Math.max(0, 2 - 0.5 / c);
        const yHi = sc.y.getPixelForValue(sHi), yLo = sc.y.getPixelForValue(sLo);
        const w = Math.min(step, chartArea.right - px);
        ctx.fillStyle = P.passBg; ctx.fillRect(px, yTop, w, yHi - yTop);
        ctx.fillStyle = P.warnBg; ctx.fillRect(px, yHi, w, yLo - yHi);
        ctx.fillStyle = P.failBg; ctx.fillRect(px, yLo, w, yBot - yLo);
      }
      ctx.restore();
    },
  };

  // Every project file's point for one category (the grey backdrop pool).
  function catPoints(k) {
    return D.rows.filter(r => r.categories[k] != null).map(r => {
      const s = r.categories[k];
      const c = r.confidences && r.confidences[k];
      const known = c != null;
      return { x: known ? Math.round(clamp(c) * 100) : 100, y: s, zone: known ? catZone(weight(s, c)) : 'na', path: r.path, conf: known ? Math.round(clamp(c) * 100) + '%' : 'n/a' };
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
