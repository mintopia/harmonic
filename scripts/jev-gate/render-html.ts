/**
 * Renders a Jev baseline (`path -> {categories, overall}`) into a single
 * self-contained HTML page: a per-file score table with zone colouring and
 * summary cards. No external assets (the workspace network is filtered), so
 * data and all CSS/JS are inlined. Used by cli.ts's optional `--html` output.
 *
 * The table, cards and footer are rendered server-side into the markup so the
 * page is fully readable with JavaScript disabled (e.g. a sandboxed file
 * viewer that strips <script>). The inline script only *enhances* it —
 * click-to-sort and path filtering — re-rendering the same data when JS runs.
 */
import type { Baseline, CategoryId } from './types.js';
import { ALL_CATEGORIES } from './types.js';

const CAT_LABELS: Record<CategoryId, string> = {
  complexity_clean_code: 'Complexity',
  code_smells: 'Smells',
  duplication: 'Duplication',
  testability: 'Testability',
  error_handling: 'Errors',
  security: 'Security',
  comments: 'Comments',
};

const catZone = (v: number | undefined): string => (v == null ? 'na' : v < 1.5 ? 'fail' : v < 2.5 ? 'warn' : 'pass');
const overallZone = (v: number): string => (v < 2.0 ? 'fail' : v < 2.4 ? 'warn' : 'pass');
const fmt = (v: number | undefined): string => (v == null ? '–' : v.toFixed(2));
const pct = (v: number): number => Math.round((v / 4) * 100);
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const chip = (v: number | undefined): string => `<td><span class="chip ${catZone(v)}">${fmt(v)}</span></td>`;

export function renderBaselineHtml(baseline: Baseline): string {
  const rows = Object.entries(baseline).map(([path, e]) => ({ path, overall: e.overall, categories: e.categories }));
  const n = rows.length;
  const meanOverall = n ? rows.reduce((s, r) => s + r.overall, 0) / n : 0;
  const catAverages = Object.fromEntries(
    ALL_CATEGORIES.map((k) => [k, n ? rows.reduce((s, r) => s + (r.categories[k] ?? 0), 0) / n : 0]),
  ) as Record<CategoryId, number>;
  const stats = {
    anyCatFail: rows.filter((r) => ALL_CATEGORIES.some((k) => catZone(r.categories[k]) === 'fail')).length,
    overallFail: rows.filter((r) => overallZone(r.overall) === 'fail').length,
    securityFail: rows.filter((r) => catZone(r.categories.security) === 'fail').length,
    commentsFail: rows.filter((r) => catZone(r.categories.comments) === 'fail').length,
  };

  const data = { rows, cats: ALL_CATEGORIES.map((k) => [k, CAT_LABELS[k]]), meanOverall, n, catAverages, stats };
  const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');

  const subText = n
    ? `${n} files scored · mean overall ${pct(meanOverall)}/100 (${meanOverall.toFixed(2)}/4)`
    : 'Baseline is empty — run --write-baseline to populate it.';

  const cards: [string, string | number, string][] = [
    ['Files scored', n, ''],
    ['Mean overall', `${pct(meanOverall)}/100`, `${meanOverall.toFixed(2)}/4`],
    ['Any category FAIL', stats.anyCatFail, `of ${n}`],
    ['Overall FAIL (<50)', stats.overallFail, `of ${n}`],
    ['Security FAIL', stats.securityFail, 'now gating'],
    ['Comments FAIL', stats.commentsFail, 'now gating'],
  ];
  const cardsHtml = cards
    .map(([k, v, s]) => `<div class="card"><div class="k">${k}</div><div class="v">${v}${s ? ` <small>${s}</small>` : ''}</div></div>`)
    .join('');

  const headCols: [string, string][] = [['path', 'File'], ['overall', 'Overall'], ...ALL_CATEGORIES.map((k) => [k, CAT_LABELS[k]] as [string, string])];
  const headHtml = headCols
    .map(([k, l]) => `<th data-k="${k}">${l}<span class="arrow">${k === 'overall' ? ' ▲' : ''}</span></th>`)
    .join('');

  // Default view: worst-first by overall (most actionable), matching the client's default sort.
  const sorted = [...rows].sort((a, b) => a.overall - b.overall);
  const bodyHtml = sorted
    .map((r) => {
      const cells = ALL_CATEGORIES.map((k) => chip(r.categories[k])).join('');
      const ov = `<td><span class="chip overall ${overallZone(r.overall)}">${pct(r.overall)}</span></td>`;
      return `<tr><td>${esc(r.path)}</td>${ov}${cells}</tr>`;
    })
    .join('');

  const footHtml = n
    ? `<td>Mean across ${n} files</td><td><span class="chip overall ${overallZone(meanOverall)}">${pct(meanOverall)}</span></td>` +
      ALL_CATEGORIES.map((k) => chip(catAverages[k])).join('')
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
  .sub { color:var(--muted); margin:0 0 20px; }
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
  th, td { padding:8px 10px; text-align:right; white-space:nowrap; border-bottom:1px solid var(--line); }
  th:first-child, td:first-child { text-align:left; white-space:normal; word-break:break-all; min-width:260px; }
  thead th { position:sticky; top:0; background:var(--panel); cursor:pointer; user-select:none; font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  thead th:hover { color:var(--ink); }
  th .arrow { opacity:.6; font-size:10px; }
  tbody tr:hover { background:color-mix(in srgb, var(--accent) 7%, transparent); }
  .chip { display:inline-block; min-width:44px; padding:2px 8px; border-radius:6px; font-variant-numeric:tabular-nums; font-weight:600; }
  .pass { color:var(--pass); background:var(--pass-bg); }
  .warn { color:var(--warn); background:var(--warn-bg); }
  .fail { color:var(--fail); background:var(--fail-bg); }
  .na { color:var(--muted); }
  .overall { font-weight:700; }
  tfoot td { font-weight:600; color:var(--muted); border-top:2px solid var(--line); }
  .legend { display:flex; gap:14px; margin:14px 0 0; flex-wrap:wrap; color:var(--muted); font-size:12px; align-items:center; }
  .legend .chip { min-width:0; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Jev code-quality baseline</h1>
  <p class="sub" id="sub">${subText}</p>
  <div class="cards" id="cards">${cardsHtml}</div>
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
    <span>Category zones:</span>
    <span class="chip fail">&lt; 1.5 fail</span>
    <span class="chip warn">1.5–&lt;2.5 warn</span>
    <span class="chip pass">≥ 2.5 pass</span>
    <span style="margin-left:12px">Overall (/100): fail &lt;50, warn &lt;60, pass ≥60</span>
  </div>
</div>
<script type="application/json" id="data">${dataJson}</script>
<script>
  const D = JSON.parse(document.getElementById('data').textContent);
  const CATS = D.cats;
  const catZone = (v) => v == null ? 'na' : v < 1.5 ? 'fail' : v < 2.5 ? 'warn' : 'pass';
  const overallZone = (v) => v < 2.0 ? 'fail' : v < 2.4 ? 'warn' : 'pass';
  const fmt = (v) => v == null ? '–' : v.toFixed(2);
  const pct = (v) => Math.round((v / 4) * 100);

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
      const av = sortKey === 'overall' ? a.overall : (a.categories[sortKey] ?? -1);
      const bv = sortKey === 'overall' ? b.overall : (b.categories[sortKey] ?? -1);
      return sortDir * (av - bv);
    });
    return rows;
  }
  const esc = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const cell = (v) => '<td><span class="chip '+catZone(v)+'">'+fmt(v)+'</span></td>';
  const body = document.getElementById('body');
  function renderBody() {
    const rows = currentRows();
    document.getElementById('count').textContent = rows.length + ' of ' + D.n + ' shown';
    body.innerHTML = rows.map(r => {
      const cells = CATS.map(([k]) => cell(r.categories[k])).join('');
      const ov = '<td><span class="chip overall '+overallZone(r.overall)+'">'+pct(r.overall)+'</span></td>';
      return '<tr><td>'+esc(r.path)+'</td>'+ov+cells+'</tr>';
    }).join('');
  }
  filterEl.placeholder = 'Filter by path…';
  renderHead(); renderBody();
</script>
</body>
</html>`;
}
