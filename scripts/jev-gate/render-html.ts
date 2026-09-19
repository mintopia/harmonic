/**
 * Renders a Jev baseline (`path -> {categories, confidences, overall}`) plus the
 * run's {@link BaselineMeta} into a single self-contained HTML page: a run-summary
 * strip, then a per-file score table with zone colouring. No external assets (the
 * workspace network is filtered), so data and all CSS/JS are inlined. Used by
 * cli.ts's optional `--html` output.
 *
 * Confidence shapes the display: each category cell shows the confidence-weighted
 * score (`score·c + 2·(1-c)` — Jev's raw score pulled toward the neutral 2.0 as it
 * grows less sure, see thresholds.ts `weightByConfidence`), and a file's overall is
 * the mean of its weighted category values. The raw score and confidence stay
 * visible (cell subtext + tooltip). The persisted baseline stores raw scores plus
 * confidences; the gate and ratchet judge the same weighted value (thresholds.ts),
 * so this display and the gate agree.
 *
 * The table, cards and footer are rendered server-side into the markup so the
 * page is fully readable with JavaScript disabled (e.g. a sandboxed file
 * viewer that strips <script>). The inline script only *enhances* it —
 * click-to-sort and path filtering — re-rendering the same data when JS runs.
 */
import type { Baseline, BaselineMeta, CategoryId } from './types.js';
import { ALL_CATEGORIES } from './types.js';
import { NEUTRAL_SCORE, weightByConfidence } from './thresholds.js';

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

/** Short tags for labelling points on the per-file scatter. */
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

interface ScatterPoint {
  x: number; // confidence, 0-100
  y: number; // raw score, 0-4
  zone: string; // 'pass' | 'warn' | 'fail' | 'na' — 'na' = no confidence for this cell
  title: string;
}

type ScatterRow = { path: string; categories: Partial<Record<CategoryId, number>>; confidences?: Partial<Record<CategoryId, number>> };

/** A file missing a confidence for this category plots at x=100%, zone 'na'. */
function catScatterPoints(cat: CategoryId, rows: readonly ScatterRow[]): ScatterPoint[] {
  const pts: ScatterPoint[] = [];
  for (const r of rows) {
    const score = r.categories[cat];
    if (score == null) continue;
    const conf = r.confidences?.[cat];
    const known = conf != null;
    const zone = known ? catZone(weighted(score, conf)) : 'na';
    const confPct = known ? Math.round(conf * 100) : 100;
    const confLabel = known ? `${confPct}%` : 'n/a';
    pts.push({ x: confPct, y: score, zone, title: `${r.path} · ${score.toFixed(2)}/4 · confidence ${confLabel}` });
  }
  return pts;
}

interface ScatterGeometry {
  w: number;
  h: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Small-multiple size used by the per-category overview plots. */
const SM_GEOM: ScatterGeometry = { w: 200, h: 150, left: 24, right: 6, top: 8, bottom: 18 };

/** Zero external assets; colour comes entirely from the `pt <zone>` CSS classes (theme-aware via CSS custom properties). */
function renderScatterSvg(points: ScatterPoint[], geom: ScatterGeometry, pointR: number, extraMarkup: string, svgClass = 'scatter'): string {
  const { w, h, left, right, top, bottom } = geom;
  const pw = w - left - right;
  const ph = h - top - bottom;
  const gx = (confPct: number): number => left + (confPct / 100) * pw;
  const gy = (score: number): number => top + ph - (score / 4) * ph;
  const gridY = [0, 1, 2, 3, 4].map((s) => `<line x1="${left}" y1="${gy(s)}" x2="${left + pw}" y2="${gy(s)}" class="grid"/>`).join('');
  const gridX = [0, 25, 50, 75, 100].map((c) => `<line x1="${gx(c)}" y1="${top}" x2="${gx(c)}" y2="${top + ph}" class="grid"/>`).join('');
  const axisLabels =
    `<text x="${left - 4}" y="${gy(4) + 3}" class="axislbl" text-anchor="end">4</text>` +
    `<text x="${left - 4}" y="${gy(0) + 3}" class="axislbl" text-anchor="end">0</text>` +
    `<text x="${left}" y="${top + ph + 12}" class="axislbl">0%</text>` +
    `<text x="${left + pw}" y="${top + ph + 12}" class="axislbl" text-anchor="end">100%</text>`;
  const dots = points
    .map((p) => `<circle cx="${gx(p.x).toFixed(1)}" cy="${gy(p.y).toFixed(1)}" r="${pointR}" class="pt ${p.zone}"><title>${esc(p.title)}</title></circle>`)
    .join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="${svgClass}" role="img">` +
    `<rect x="${left}" y="${top}" width="${pw}" height="${ph}" class="plotbox"/>${gridY}${gridX}${axisLabels}${extraMarkup}${dots}</svg>`;
}

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

  const scatterCellsHtml = ALL_CATEGORIES.map((k) => {
    const pts = catScatterPoints(k, rows);
    const svg = renderScatterSvg(pts, SM_GEOM, 2.4, '');
    return `<div class="scatter-cell"><div class="scatter-title">${CAT_LABELS[k]}</div>${svg}</div>`;
  }).join('');

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
  .scatter-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:14px; margin-bottom:24px; }
  .scatter-cell { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:10px; }
  .scatter-title { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; margin-bottom:4px; }
  svg.scatter { width:100%; height:auto; display:block; overflow:visible; }
  svg.scatter .grid { stroke:var(--line); stroke-width:1; }
  svg.scatter .plotbox { fill:none; stroke:var(--line); }
  svg.scatter .axislbl { font-size:8px; fill:var(--muted); }
  svg.scatter .ptlabel { font-size:9px; fill:var(--ink); font-weight:600; }
  svg.scatter circle.pt { stroke:var(--panel); stroke-width:0.6; }
  svg.scatter circle.pass { fill:var(--pass); }
  svg.scatter circle.warn { fill:var(--warn); }
  svg.scatter circle.fail { fill:var(--fail); }
  svg.scatter circle.na { fill:var(--muted); opacity:.6; }
  svg.scatter circle.cloud { fill:var(--muted); opacity:.18; stroke:none; }
  svg.scatter-big { max-width:440px; }
  tr.filerow { cursor:pointer; }
  .caret { display:inline-block; width:10px; color:var(--muted); }
  tr.detail-row td { background:var(--bg); border-bottom:1px solid var(--line); }
  .detail-panel { padding:10px 4px; display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap; white-space:normal; }
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

  function buildCloud() {
    const pts = [];
    for (const r of D.rows) {
      for (const kv of CATS) {
        const k = kv[0];
        const score = r.categories[k];
        if (score == null) continue;
        const conf = r.confidences && r.confidences[k];
        const confPct = conf == null ? 100 : Math.round(clamp(conf) * 100);
        pts.push([confPct, score]);
      }
    }
    return pts;
  }
  const CLOUD = buildCloud();

  const expanded = new Set();

  function fileScatterSvg(row) {
    const W = 420, H = 280, L = 32, R = 12, T = 10, B = 26;
    const PW = W - L - R, PH = H - T - B;
    const gx = (c) => L + (c / 100) * PW;
    const gy = (s) => T + PH - (s / 4) * PH;
    const gridY = [0,1,2,3,4].map((s) => '<line x1="'+L+'" y1="'+gy(s)+'" x2="'+(L+PW)+'" y2="'+gy(s)+'" class="grid"/>').join('');
    const gridX = [0,25,50,75,100].map((c) => '<line x1="'+gx(c)+'" y1="'+T+'" x2="'+gx(c)+'" y2="'+(T+PH)+'" class="grid"/>').join('');
    const axisLbl = '<text x="'+(L-4)+'" y="'+(gy(4)+3)+'" class="axislbl" text-anchor="end">4</text>'
      + '<text x="'+(L-4)+'" y="'+(gy(0)+3)+'" class="axislbl" text-anchor="end">0</text>'
      + '<text x="'+L+'" y="'+(T+PH+14)+'" class="axislbl">0%</text>'
      + '<text x="'+(L+PW)+'" y="'+(T+PH+14)+'" class="axislbl" text-anchor="end">100%</text>';
    const cloud = CLOUD.map((pt) => '<circle cx="'+gx(pt[0]).toFixed(1)+'" cy="'+gy(pt[1]).toFixed(1)+'" r="2" class="pt cloud"/>').join('');
    const pts = CATS.map((kv) => {
      const k = kv[0], label = kv[1];
      const score = row.categories[k];
      if (score == null) return '';
      const conf = row.confidences && row.confidences[k];
      const known = conf != null;
      const w = weight(score, conf);
      const zone = known ? catZone(w) : 'na';
      const confPct = known ? Math.round(clamp(conf) * 100) : 100;
      const confLbl = known ? Math.round(clamp(conf) * 100) + '%' : 'n/a';
      const cx = gx(confPct), cy = gy(score);
      const short = D.catShort[k];
      const title = label + ' · ' + score.toFixed(2) + '/4 · confidence ' + confLbl;
      return '<circle cx="'+cx.toFixed(1)+'" cy="'+cy.toFixed(1)+'" r="4.5" class="pt '+zone+'"><title>'+esc(title)+'</title></circle>'
        + '<text x="'+(cx+6).toFixed(1)+'" y="'+(cy-6).toFixed(1)+'" class="ptlabel">'+short+'</text>';
    }).join('');
    return '<svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" class="scatter scatter-big" role="img">'
      + '<rect x="'+L+'" y="'+T+'" width="'+PW+'" height="'+PH+'" class="plotbox"/>' + gridY + gridX + axisLbl + cloud + pts + '</svg>';
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
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const cell = (score, conf) => {
    const w = weight(score, conf);
    const c = conf == null ? '–' : Math.round(conf * 100) + '%';
    const title = score == null ? 'not scored' : 'raw ' + score.toFixed(2) + ' · confidence ' + c;
    const sub = score == null ? '' : '<span class="conf">' + c + '</span>';
    return '<td><span class="chip '+catZone(w)+'" title="'+title+'">'+fmt(w)+'</span>'+sub+'</td>';
  };
  const body = document.getElementById('body');
  function renderBody() {
    const rows = currentRows();
    document.getElementById('count').textContent = rows.length + ' of ' + D.n + ' shown';
    body.innerHTML = rows.map(r => {
      const cells = CATS.map(([k]) => cell(r.categories[k], r.confidences && r.confidences[k])).join('');
      const ov = '<td><span class="chip overall '+overallZone(rowOverall(r))+'">'+pct(rowOverall(r))+'</span></td>';
      const isOpen = expanded.has(r.path);
      const caret = '<span class="caret">'+(isOpen ? '▾' : '▸')+'</span> ';
      const mainRow = '<tr class="filerow" data-path="'+esc(r.path)+'"><td>'+caret+esc(r.path)+'</td>'+ov+cells+'</tr>';
      const detailRow = isOpen
        ? '<tr class="detail-row"><td colspan="'+(CATS.length+2)+'"><div class="detail-panel">'+fileScatterSvg(r)
          + '<p class="detail-hint">Bold labelled points: this file’s 8 categories. Faint cloud: every file × category, for context.</p></div></td></tr>'
        : '';
      return mainRow + detailRow;
    }).join('');
    body.querySelectorAll('tr.filerow').forEach((tr) => {
      tr.onclick = () => {
        const p = tr.dataset.path;
        if (expanded.has(p)) expanded.delete(p); else expanded.add(p);
        renderBody();
      };
    });
  }
  filterEl.placeholder = 'Filter by path…';
  renderHead(); renderBody();
</script>
</body>
</html>`;
}
