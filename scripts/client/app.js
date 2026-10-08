let D = /*__DATA__*/ null;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtMs = (ms) => (ms >= 60000 ? (ms / 60000).toFixed(1) + ' min' : (ms / 1000).toFixed(1) + ' s');
const fmtT = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const label = { pass: 'Healthy', warn: 'Warnings', fail: 'Failing' };
const verdictLabel = { identical: 'Identical', minor: 'Minor differences', different: 'Different', incomplete: 'Incomplete', missing: 'Not reached' };
const verdictClass = { identical: 'pass', minor: 'warn', different: 'fail', incomplete: 'custom', missing: 'custom' };
const worst = (a) => (a.includes('fail') ? 'fail' : a.includes('warn') ? 'warn' : 'pass');
const clone = (o) => JSON.parse(JSON.stringify(o));
const envLabel = (id) => D.envs.find((e) => e.id === id)?.label ?? id;
const copyText = (t, done = 'Copied') => {
  const ok = () => toast(done);
  try { navigator.clipboard.writeText(t).then(ok, () => toast('Could not copy. Select the text and copy it by hand.')); } catch { toast('Could not copy. Select the text and copy it by hand.'); }
};
/** small confirmation that fades out, announced to screen readers */
function toast(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2200);
}
/** scroll an element into view and flash it, so a click visibly lands somewhere */
function focusOn(el) {
  if (!el) return;
  el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}
/** open one product on the Monitor tab from any other tab */
function openProduct(id) {
  S.view = 'monitor'; S.selected = id; S.openRun = null; render();
  jumpToDetail();
}

const S = {
  view: 'monitor', env: 'production', selected: null, openRun: null,
  cmpProduct: null, cmpRun: null,
  drawer: null, histFilter: 'all', histAll: false, live: false, manifests: [], secrets: {}, editSecret: false, product: null, model: null, runEnv: 'production', errors: [], starting: false, run: null, timer: null,
};

// ---------- helpers: runs ----------
const envRuns = (p) => p.runs.filter((r) => r.env === S.env);
const suitesOf = (p) => [...new Set(envRuns(p).map((r) => r.suite))];
const suiteName = (p, id) => envRuns(p).find((r) => r.suite === id)?.suiteName ?? id;
const productsInEnv = () => D.products.filter((p) => envRuns(p).length);
const scheduled = (p) => envRuns(p).filter((r) => !r.custom); // dashboard-started custom runs stay out of health stats
const basis = (p) => (scheduled(p).length ? scheduled(p) : envRuns(p));
/** the newest regular run of each test suite in this product line (a product can have several suites) */
const latestBySuite = (p) => suitesOf(p).map((id) => basis(p).filter((r) => r.suite === id).at(-1)).filter(Boolean);

// ---------- shell ----------
function shell() {
  $('#gen').textContent = 'Updated ' + fmtT(D.generatedAt);
  $('#tabs').innerHTML = [['monitor', 'Monitor'], ['insights', 'Insights'], ['marketing', 'Marketing'], ['compare', 'Compare environments'], ['run', 'Run tests']]
    .map(([id, t]) => `<button role="tab" data-v="${id}" aria-selected="${S.view === id}">${t}</button>`).join('')
    + (S.view === 'monitor'
      ? `<span class="envsw" role="group" aria-label="Environment">${D.envs.map((e) => `<button data-env="${e.id}" aria-pressed="${S.env === e.id}">${esc(e.label)}</button>`).join('')}</span>`
      : '');
  document.querySelectorAll('#tabs [data-v]').forEach((b) => (b.onclick = () => { S.view = b.dataset.v; render(); scrollTo({ top: 0 }); }));
  document.querySelectorAll('#tabs [data-env]').forEach((b) => (b.onclick = () => { S.env = b.dataset.env; S.selected = null; S.openRun = null; render(); }));
}

function render() {
  syncHash();
  shell();
  if (S.view !== 'monitor' && S.drawer) { S.drawer = null; renderDrawer(); }
  if (S.view === 'run') return renderRun();
  clearInterval(S.timer); S.timer = null;
  if (S.view === 'compare') return renderCompare();
  if (S.view === 'insights') return renderInsights();
  if (S.view === 'marketing') return renderMarketing();
  renderMonitor();
}

// ---------- monitor (status board) ----------
const STEP_LABEL = {
  homepage: 'Home', 'travel-category': 'Category', 'car-category': 'Category', 'funnel-landing': 'Funnel', 'trip-details': 'Trip', plans: 'Plans',
  'add-ons': 'Add-ons', 'participant-details': 'Participant', 'flight-details': 'Flight', summary: 'Summary', 'summary-ready-to-pay': 'Ready to pay',
  'lookup-form-filled': 'Form filled', 'lookup-response': 'Lookup', category: 'Category', 'entry-page': 'Entry page',
};
const baseName = (p) => p.split('/').pop().replace(/^\d+-/, '').replace(/\.png$/, '');
const stepLabel = (n) => STEP_LABEL[n] ?? n.replace(/^record-page-(\d+)-.*/, 'Page $1').replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
const ago = (iso) => {
  const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? Math.round(m) + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago';
};
const STALE_H = 36; // a funnel nobody has tested for this long is flagged, in case the schedule stopped
const fmtS = (s) => (s >= 100 ? Math.round(s) + 's' : s.toFixed(1) + 's');

function heatModel(run) {
  const per = run.results.map((r) => {
    const shots = r.steps.filter((s) => s.level === 'SHOT').map((s) => ({ name: baseName(s.msg), ts: Date.parse(s.ts) }));
    let prev = Date.parse(r.steps[0]?.ts ?? r.startedAt);
    const times = {};
    for (const sh of shots) { times[sh.name] = (sh.ts - prev) / 1000; prev = sh.ts; }
    return { r, names: shots.map((x) => x.name), times };
  });
  const cols = [];
  for (const p of [...per].sort((a, b) => b.names.length - a.names.length)) for (const n of p.names) if (!cols.includes(n)) cols.push(n);
  return { per, cols };
}

function cellOf(p, cols, col, ci) {
  const failed = p.r.status !== 'passed';
  const firstMissing = cols.findIndex((c) => !p.names.includes(c));
  if (p.names.includes(col)) {
    // a failed run that got through every step failed on the last one (e.g. the page loaded as an error page)
    if (failed && firstMissing === -1 && ci === cols.length - 1) return { st: 'fail', t: p.times[col] };
    return { st: 'ok', t: p.times[col] };
  }
  if (failed) return { st: ci === firstMissing ? 'fail' : 'skip' };
  return { st: 'na' };
}

/** bring the selected product's results into view (they sit below the product table) and flash them so the click visibly did something */
function jumpToDetail() { focusOn($('#detail')); }

function renderMonitor() {
  const prods = productsInEnv();
  if (!prods.length) {
    const other = D.envs.find((e) => e.id !== S.env);
    $('#main').innerHTML = `<div class="empty">No runs on <b>${esc(envLabel(S.env))}</b> yet. Open the <b>Run tests</b> tab and choose this environment${other ? `, or switch to ${esc(other.label)} above` : ''}.</div>`;
    return;
  }
  if (!prods.some((p) => p.id === S.selected)) S.selected = prods[0].id;
  const rows = prods.map((p) => { const latest = latestBySuite(p); return { p, latest, b: basis(p).slice().sort((x, y) => x.startedAt.localeCompare(y.startedAt)), health: worst(latest.map((r) => r.health)) }; });
  const failing = rows.filter((x) => x.health === 'fail');
  const warnRows = rows.filter((x) => x.health === 'warn');
  const all = rows.flatMap((x) => x.latest);
  const scen = all.reduce((a, r) => a + r.total, 0), ok = all.reduce((a, r) => a + r.passed, 0);
  const warnScen = all.reduce((a, r) => a + r.results.filter((x) => x.health === 'warn').length, 0);
  const newest = all.map((r) => r.startedAt).sort().at(-1);
  const stale = rows.filter((x) => x.latest.some((r) => (Date.now() - Date.parse(r.startedAt)) / 3.6e6 > STALE_H));
  const state = failing.length ? 'fail' : 'pass';
  const title = failing.length ? `${failing.length} of ${rows.length} product${rows.length > 1 ? 's' : ''} failing` : rows.length > 1 ? 'All products are up' : 'The product is up';
  const why = failing.length
    ? failing.map((x) => {
      const bad = x.latest.filter((r) => r.health === 'fail');
      return `<a href="#detail" data-failjump="${x.p.id}">${esc(x.p.name)}</a>: ${bad.map((r) => `${esc(r.suiteName)} (${r.total - r.passed} of ${r.total} failed)`).join(', ')}`;
    }).join(' &nbsp;·&nbsp; ')
    : warnRows.length ? `Every journey completed. ${warnScen} scenario(s) logged first-party errors (shown as warnings).` : 'Every scenario in the latest runs completed.';

  const prodCols = '--cols:124px minmax(170px,1.5fr) minmax(150px,1.2fr) 92px 92px 84px 110px';
  const shownRows = rows.filter((x) => !S.statusFilter || (S.statusFilter === 'pass' ? x.health === 'pass' : x.health === S.statusFilter));
  const cnt = (h) => rows.filter((x) => x.health === h).length;
  const prodRows = shownRows.map((x) => {
    const passed = x.latest.reduce((a, r) => a + r.passed, 0), total = x.latest.reduce((a, r) => a + r.total, 0);
    const dur = x.latest.reduce((a, r) => a + r.durationMs, 0);
    const last = x.latest.map((r) => r.startedAt).sort().at(-1);
    const suites = x.latest.map((r) => r.suiteName).join(' + ');
    return `<button class="gt-row" data-p="${x.p.id}" aria-selected="${x.p.id === S.selected}">
      <span><span class="pill ${x.health}">${label[x.health]}</span></span>
      <span class="name">${esc(x.p.name)} <span class="mute" style="font-weight:400;font-size:14px">${esc(suites)}</span></span>
      <span class="runs-strip hide-s" title="last ${x.b.length} runs, oldest to newest">${x.b.slice(-30).map((r) => `<i class="${r.health}" title="${esc(fmtT(r.startedAt))}: ${esc(r.suiteName)} ${r.passed}/${r.total}"></i>`).join('')}</span>
      <span class="num hide-s">${Math.round((x.b.filter((r) => r.health !== 'fail').length / x.b.length) * 100)}%</span>
      <span class="num">${passed}/${total}</span>
      <span class="num hide-s">${fmtMs(dur)}</span>
      <span class="num ${(Date.now() - Date.parse(last)) / 3.6e6 > STALE_H ? 'stale' : ''}" title="${esc(fmtT(last))}">${ago(last)} <span class="chev" aria-hidden="true">›</span></span></button>`;
  }).join('');

  $('#main').innerHTML = `
    <div class="strip ${state}">
      <div><h2>${title}</h2><div class="why">${why}</div></div>
      <div class="counts">
        <div><b>${ok}/${scen}</b><span>scenarios passing</span></div>
        <div><b>${warnScen}</b><span>with warnings</span></div>
        <div><b>${ago(newest)}</b><span>last run · ${esc(envLabel(S.env))}</span></div>
      </div>
    </div>
    ${stale.length ? `<p class="chip warn" style="margin:8px 0 0">No run in the last ${STALE_H} h for ${stale.map((x) => esc(x.p.name)).join(', ')}. Is the schedule running?</p>` : ''}
    <div class="panel"><h2>Products <span class="chip">${esc(envLabel(S.env))}</span><span class="mute" style="font-weight:400;font-size:14px">Click a product to see its results below</span></h2>
      <div class="gt t-prod" style="${prodCols}">
        <div class="gt-head"><span>Status</span><span>Product</span><span class="hide-s">Last runs</span><span class="r hide-s">Availability</span><span class="r">Scenarios</span><span class="r hide-s">Duration</span><span class="r">Last run</span></div>
        ${prodRows || '<div class="gt-row" style="cursor:default"><span class="mute">No product has this status.</span></div>'}</div>
      <div class="filters" role="group" aria-label="Filter products by status">${[['', `All ${rows.length}`], ['fail', `Failing ${cnt('fail')}`], ['warn', `Warnings ${cnt('warn')}`], ['pass', `Healthy ${cnt('pass')}`]].map(([k, t]) => `<button data-sf="${k}" aria-pressed="${(S.statusFilter ?? '') === k}">${t}</button>`).join('')}<button id="copystatus" style="margin-left:auto">Copy status update</button></div></div>
    <div id="detail"></div>`;
  document.querySelectorAll('.gt-row[data-p]').forEach((b) => (b.onclick = () => { S.selected = b.dataset.p; S.openRun = null; renderMonitor(); jumpToDetail(); }));
  document.querySelectorAll('[data-sf]').forEach((b) => (b.onclick = () => { S.statusFilter = b.dataset.sf || null; renderMonitor(); }));
  $('#copystatus').onclick = () => copyText(`${title} (${envLabel(S.env)}, ${fmtT(newest)})\n` + rows.map((x) => `- ${x.p.name}: ${label[x.health]}, ${x.latest.reduce((a, r) => a + r.passed, 0)}/${x.latest.reduce((a, r) => a + r.total, 0)} scenarios`).join('\n') + (failing.length ? `\nFailing: ${why.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')}` : ''), 'Status update copied');
  document.querySelectorAll('[data-failjump]').forEach((b) => (b.onclick = () => { S.selected = b.dataset.failjump; S.openRun = null; renderMonitor(); jumpToDetail(); }));
  detail();
}

function dataUsed(run) {
  if (!run.data) return '';
  const p = run.data.participant, f = run.data.flight;
  return `<p class="note" style="margin:0 16px 8px"><b>Custom test data</b> - ${esc(p.fullName)}, NRIC ${esc(p.nric)}, ${esc(p.mobile)}, ${esc(p.email)}, postcode ${esc(p.postcode)}; ${esc(f.carrier)} ${esc(f.outboundNo)} / ${esc(f.returnNo)}; ${esc(run.data.bank?.bankName || '')}</p>`;
}

const prettyScenario = (id) => {
  const t = id.replace(/^scenario-\d+-?/, '').replace(/^(car|motorcycle|travel|home|personal-accident|health|hibah|savings)-/, '').replace(/-/g, ' ').trim() || id;
  return t.charAt(0).toUpperCase() + t.slice(1);
};

function heatPanel(p, run) {
  const { per, cols } = heatModel(run);
  const heatCols = `--cols:minmax(200px,1.5fr) repeat(${cols.length},minmax(58px,1fr)) 160px`;
  const heatRows = per.map((pp, i) => {
    const cells = cols.map((c, ci) => {
      const x = cellOf(pp, cols, c, ci);
      const txt = x.st === 'ok' ? fmtS(x.t) : x.st === 'fail' ? 'FAIL' : x.st === 'skip' ? '·' : '–';
      const tip = x.st === 'ok' ? `${stepLabel(c)}: reached in ${fmtS(x.t)}` : x.st === 'fail' ? `${stepLabel(c)}: the journey stopped before this step` : x.st === 'skip' ? `${stepLabel(c)}: not reached` : `${stepLabel(c)}: not part of this scenario`;
      return `<span class="hc ${x.st}" title="${esc(tip)}" aria-label="${esc(tip)}">${txt}</span>`;
    }).join('');
    return `<button class="gt-row" data-ri="${i}" data-suite="${esc(run.suite)}" aria-label="Open details for ${esc(pp.r.scenario)}">
      <span class="name" title="${esc(pp.r.scenario)}">${esc(prettyScenario(pp.r.scenario))}</span>${cells}
      <span class="r" style="display:flex;gap:8px;justify-content:flex-end;align-items:center"><span class="pill ${pp.r.health}">${label[pp.r.health]}</span><span class="num mute" style="min-width:42px">${fmtS(pp.r.durationMs / 1000)}</span></span></button>`;
  }).join('');
  return `<div class="panel"><h2>${esc(run.suiteName)} <span class="pill ${run.health}">${label[run.health]}</span><span class="chip">${esc(run.runId)}</span><span class="chip">${esc(ago(run.startedAt))}</span>${run.device === 'mobile' ? '<span class="pill custom">phone size</span>' : run.custom ? '<span class="pill custom">custom data</span>' : ''}</h2>
      <div class="sub2">${esc(p.name)} on ${esc(envLabel(run.env))}, ${esc(run.baseUrl)}. Each cell is how long that step took to reach. Click a row for details.</div>
      ${dataUsed(run)}
      ${run.results.some((r) => r.sensitive) ? '<p class="note" style="margin:0 16px 8px"><b>Saved test record used.</b> Its screenshots are shown here only; they are left out of the shared dashboard link.</p>' : ''}
      <div class="heat"><div class="gt t-heat" style="${heatCols}"><div class="gt-head"><span>Scenario</span>${cols.map((c) => `<span style="text-align:center" title="${esc(c)}">${esc(stepLabel(c))}</span>`).join('')}<span class="r">Result</span></div>${heatRows}</div></div>
      <div class="legend"><span><i class="ok"></i>reached (time)</span><span><i class="fail"></i>journey stopped here</span><span><i class="skip"></i>not reached</span><span><i class="na"></i>not in this scenario</span></div></div>`;
}

function detail() {
  const p = D.products.find((x) => x.id === S.selected);
  if (!p) { $('#detail').innerHTML = ''; return; }
  const list = envRuns(p);
  // one steps panel per test suite: the picked run if it belongs to that suite, otherwise the newest regular run
  const shown = suitesOf(p).map((id) => (S.openRun?.suite === id && list.find((r) => r.suite === id && r.runId === S.openRun.runId)) || basis(p).filter((r) => r.suite === id).at(-1)).filter(Boolean);
  // a saved-record run (genuine data, journey to Summary) is a custom run, so it is not the "regular" run above: give it its own panel
  for (const id of suitesOf(p)) {
    const rec = list.filter((r) => r.suite === id && r.custom && r.device !== 'mobile' && r.results.some((x) => x.sensitive)).at(-1);
    if (rec && !shown.includes(rec)) shown.push(rec);
    const ph = list.filter((r) => r.suite === id && r.device === 'mobile').at(-1);
    if (ph && !shown.includes(ph)) shown.push(ph);
  }
  const panels = shown.map((run) => ({ run, html: heatPanel(p, run), model: heatModel(run) }));

  const showAll = S.histAll;
  const dayOf = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }; // local calendar day
  const hist = [...list].sort((x, y) => y.startedAt.localeCompare(x.startedAt) || x.suite.localeCompare(y.suite))
    .filter((r) => (S.histFilter === 'custom' ? r.custom : S.histFilter === 'scheduled' ? !r.custom : true))
    .filter((r) => !S.histFrom || dayOf(r.startedAt) >= S.histFrom)
    .filter((r) => !S.histTo || dayOf(r.startedAt) <= S.histTo)
    .filter((r) => !S.histResult || (S.histResult === 'fail' ? r.health === 'fail' : r.health !== 'fail'));
  const narrowed = !!(S.histFrom || S.histTo || S.histResult);
  const maxD = Math.max(...list.map((r) => r.durationMs), 1);
  const histCols = '--cols:minmax(180px,1.4fr) 130px 150px 80px 92px 150px minmax(80px,1fr)';
  const histRows = (showAll ? hist : hist.slice(0, 12)).map((r) => `<button class="gt-row" data-r="${esc(r.runId)}" data-suite="${esc(r.suite)}" aria-selected="${shown.some((x) => x.runId === r.runId && x.suite === r.suite)}">
      <span class="name" style="font-variant-numeric:tabular-nums">${esc(r.runId)}</span><span>${esc(r.suiteName)}</span><span class="mute hide-s">${esc(fmtT(r.startedAt))}</span>
      <span class="hide-s">${r.custom ? '<span class="pill custom">custom</span>' : '<span class="mute">regular</span>'}</span>
      <span class="num">${fmtMs(r.durationMs)}</span>
      <span><span class="pill ${r.health}">${r.passed}/${r.total} ${label[r.health]}</span></span><span class="bar hide-s" title="${fmtMs(r.durationMs)}"><i style="width:${Math.max(4, (r.durationMs / maxD) * 100)}%"></i></span></button>`).join('');

  $('#detail').innerHTML = `<div class="detail-h"><h2>${esc(p.name)}</h2><span class="mute">${panels.length} test suite${panels.length > 1 ? 's' : ''} · click a scenario row for steps, log and screenshots</span><button class="btn" id="totop">Back to products ↑</button></div>` + panels.map((x) => x.html).join('') + `
    <div class="panel"><h2>Run history <span class="chip">${esc(p.name)}</span><span class="chip">${esc(envLabel(S.env))}</span></h2>
      <div class="filters" role="group" aria-label="Filter runs">${[['all', 'All'], ['scheduled', 'Regular'], ['custom', 'Custom data']].map(([k, t]) => `<button data-hf="${k}" aria-pressed="${S.histFilter === k}">${t}</button>`).join('')}</div>
      <div class="filters" role="group" aria-label="Search by date and result" style="align-items:center;flex-wrap:wrap">
        <label class="mute" for="hf-from">From</label><input type="date" id="hf-from" value="${esc(S.histFrom ?? '')}" style="font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:var(--r-ctl);padding:3px 8px">
        <label class="mute" for="hf-to">To</label><input type="date" id="hf-to" value="${esc(S.histTo ?? '')}" style="font:inherit;color:var(--ink);background:var(--field);border:1px solid var(--line);border-radius:var(--r-ctl);padding:3px 8px">
        ${[['', 'Any result'], ['pass', 'Passed / warnings'], ['fail', 'Failed']].map(([k, t]) => `<button data-hr="${k}" aria-pressed="${(S.histResult ?? '') === k}">${t}</button>`).join('')}
        ${narrowed ? '<button id="hf-clear">Clear</button>' : ''}
        <span class="mute" style="font-size:14px">${hist.length} of ${list.length} runs</span>
      </div>
      <div class="gt t-hist" style="${histCols}"><div class="gt-head"><span>Run</span><span>Suite</span><span class="hide-s">When</span><span class="hide-s">Type</span><span class="r">Duration</span><span>Result</span><span class="hide-s">Relative</span></div>${histRows || '<div class="gt-row" style="cursor:default"><span class="mute">No runs match these filters. Try a wider date range.</span></div>'}</div>
      ${hist.length > 12 ? `<div class="panel-pad"><button class="btn" id="histmore">${showAll ? 'Show fewer' : 'Show all ' + hist.length}</button></div>` : ''}</div>`;

  document.querySelectorAll('.heat .gt-row[data-ri]').forEach((b) => (b.onclick = () => {
    const x = panels.find((q) => q.run.suite === b.dataset.suite);
    openDrawer(x.run, x.model.per[+b.dataset.ri].r);
  }));
  document.querySelectorAll('.gt-row[data-r]').forEach((b) => (b.onclick = () => { S.openRun = { suite: b.dataset.suite, runId: b.dataset.r }; detail(); scrollTo({ top: 0, behavior: 'smooth' }); }));
  document.querySelectorAll('[data-hf]').forEach((b) => (b.onclick = () => { S.histFilter = b.dataset.hf; detail(); }));
  const setDate = (k) => (e) => { S[k] = e.target.value || null; S.histAll = false; detail(); };
  $('#hf-from').onchange = setDate('histFrom'); $('#hf-to').onchange = setDate('histTo');
  document.querySelectorAll('[data-hr]').forEach((b) => (b.onclick = () => { S.histResult = b.dataset.hr || null; detail(); }));
  const clr = $('#hf-clear'); if (clr) clr.onclick = () => { S.histFrom = S.histTo = S.histResult = null; detail(); };
  $('#totop').onclick = () => scrollTo({ top: 0, behavior: 'smooth' });
  const more = $('#histmore'); if (more) more.onclick = () => { S.histAll = !S.histAll; detail(); };
}

// ---------- side panel for one scenario ----------
function openDrawer(run, r) { S.drawer = { runId: run.runId, env: run.env, suite: run.suite, scenario: r.scenario }; renderDrawer(); }
function closeDrawer() { S.drawer = null; renderDrawer(); }

function renderDrawer() {
  const root = $('#drawer-root');
  if (!S.drawer) { root.innerHTML = ''; document.body.style.overflow = ''; return; }
  const p = D.products.find((x) => x.id === S.selected);
  const run = p?.runs.find((x) => x.runId === S.drawer.runId && x.env === S.drawer.env && x.suite === S.drawer.suite);
  const r = run?.results.find((x) => x.scenario === S.drawer.scenario);
  if (!r) { root.innerHTML = ''; return; }
  document.body.style.overflow = 'hidden';
  const steps = r.steps.filter((s) => s.level !== 'SHOT');
  root.innerHTML = `<div class="scrim" id="scrim"></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-label="Scenario details">
      <div class="drawer-h"><div><h3>${esc(prettyScenario(r.scenario))}</h3><div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap"><span class="pill ${r.health}">${label[r.health]}</span><span class="chip">${esc(run.suiteName)}</span><span class="chip">${esc(envLabel(run.env))}</span><span class="chip">${esc(run.runId)}</span></div></div>
        <button class="x" id="dclose" aria-label="Close details">Close</button></div>
      <div class="drawer-b">
        <dl class="kvs"><dt>Started</dt><dd>${esc(fmtT(r.startedAt))}</dd><dt>Duration</dt><dd>${fmtMs(r.durationMs)}</dd><dt>Ended at</dt><dd>${esc(r.stoppedAt || 'completed')}</dd>
          <dt>API calls</dt><dd>${r.api.total - r.api.failed} of ${r.api.total} ok</dd><dt>Errors</dt><dd>${r.httpErrors.length} HTTP, ${r.consoleErrors.length} console</dd><dt>Site</dt><dd>${esc(run.baseUrl)}</dd></dl>
        ${r.error ? `<h4>Why it failed</h4><div class="err">${esc(r.error)}</div>` : ''}
        ${r.httpErrors.length ? `<h4>HTTP failures</h4><ul>${r.httpErrors.map((e) => `<li>${esc(e.method)} ${esc(e.url)} - ${esc(e.status)}</li>`).join('')}</ul>` : ''}
        ${r.consoleErrors.length ? `<h4>Console errors (${r.consoleErrors.length})</h4><pre class="steps" style="white-space:pre-wrap">${esc(r.consoleErrors.join('\n'))}</pre>` : ''}
        <h4>Steps ${r.logPath ? `<a href="${esc(r.logPath)}" style="text-transform:none;letter-spacing:0">raw log</a>` : ''}</h4>
        <ul class="steps">${steps.map((s) => `<li><span class="t">${new Date(s.ts).toLocaleTimeString([], { hour12: false })}</span><span class="L-${s.level}">${s.level}</span><span>${esc(s.msg)}</span></li>`).join('')}</ul>
        <h4>Screenshots</h4>
        ${r.screenshots.length ? `<div class="shots">${r.screenshots.map((s) => `<a href="${esc(s)}" target="_blank"><img loading="lazy" src="${esc(s)}" alt="${esc(baseName(s))}"></a>`).join('')}</div>` : '<p class="mute">No screenshots are kept for this run here.</p>'}
      </div></aside>`;
  $('#scrim').onclick = closeDrawer;
  $('#dclose').onclick = closeDrawer;
  $('#dclose').focus();
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.drawer) closeDrawer(); });

// ---------- compare environments ----------
function topDifferences(c, max) {
  const A = c.envA.label, B = c.envB.label, out = [], minor = [];
  for (const s of c.scenarios) {
    if (s.overall === 'incomplete') out.push(`${s.scenario}: did not complete in both environments (${A} ${s.statusA}, ${B} ${s.statusB})`);
    for (const f of s.flow) out.push(`${s.scenario}: flow - ${f}`);
    for (const f of s.facts) out.push(`${s.scenario}: ${f.key} is ${f.a} in ${A} but ${f.b} in ${B}`);
    for (const st of s.design) {
      if (st.verdict === 'minor') { minor.push(`${s.scenario}: minor design difference at "${st.step}" (${st.pixelPct}% of pixels${st.heightDiff ? `, page height ${st.heightDiff}px apart` : ''})`); continue; }
      if (st.verdict !== 'different') continue;
      const bits = [];
      if (st.pixelPct >= 5) bits.push(`${st.pixelPct}% of pixels differ`);
      for (const c2 of st.content) bits.push(c2.kind === 'visible inputs' ? `${c2.a} vs ${c2.b} visible inputs` : `${c2.kind} differ`);
      if (st.styles.length) bits.push(`${st.styles.length} style value(s) differ`);
      out.push(`${s.scenario}: design at "${st.step}" - ${bits.join(', ') || 'differs'}`);
    }
  }
  return [...out, ...minor].slice(0, max); // real differences first, minor ones after
}

function summaryText(c) {
  const m = c.summary;
  const lines = [`${c.productName}: ${c.envA.label} vs ${c.envB.label} (${c.runId})`,
    `${m.scenarios} scenario(s) compared: ${m.identical} identical, ${m.minor} minor design differences, ${m.different} different, ${m.incomplete} incomplete.`,
    `Flow differences: ${m.flowDifferent}. Data differences (plans, prices, totals): ${m.factsDifferent}. Design differences: ${m.designDifferent} (${m.designMinor} minor).`];
  const top = topDifferences(c, 15);
  if (top.length) lines.push('', 'Differences:', ...top.map((t) => '- ' + t));
  else lines.push('', 'No differences found.');
  return lines.join('\n');
}

function designStep(st, A, B) {
  const px = st.pixelPct == null ? 'not compared' : st.pixelPct + '% pixels differ' + (st.sizeMismatch ? ' (page widths differ)' : '') + (st.heightDiff ? `; page height differs by ${st.heightDiff}px (${st.heightPct}%)` : '');
  const content = st.content.map((c) => c.kind === 'visible inputs'
    ? `<li>${c.kind}: ${c.a} vs ${c.b}</li>`
    : `<li>${esc(c.kind)}: only in ${esc(A)}: ${esc(c.onlyA.join(' | ') || '-')}; only in ${esc(B)}: ${esc(c.onlyB.join(' | ') || '-')}</li>`).join('');
  const styles = st.styles.map((x) => `<li><code>${esc(x.prop)}</code>: ${esc(x.a)} vs ${esc(x.b)}</li>`).join('');
  const imgs = st.images ? `<div class="trio"><figure><figcaption>${esc(A)}</figcaption><a href="${esc(st.images.a)}" target="_blank"><img loading="lazy" src="${esc(st.images.a)}" alt=""></a></figure>
      <figure><figcaption>${esc(B)}</figcaption><a href="${esc(st.images.b)}" target="_blank"><img loading="lazy" src="${esc(st.images.b)}" alt=""></a></figure>
      <figure><figcaption>Difference</figcaption><a href="${esc(st.images.diff)}" target="_blank"><img loading="lazy" src="${esc(st.images.diff)}" alt=""></a></figure></div>` : '';
  return `<details class="dstep"><summary><span class="pill ${verdictClass[st.verdict]}">${verdictLabel[st.verdict]}</span> <b>${esc(st.step)}</b> <span class="mute">${esc(px)}</span></summary>
    ${st.paths ? `<p>Page path: ${esc(st.paths.a)} vs ${esc(st.paths.b)}</p>` : ''}
    ${content ? `<p><b>Content</b></p><ul>${content}</ul>` : ''}${styles ? `<p><b>Styles</b></p><ul>${styles}</ul>` : ''}${imgs}</details>`;
}

function renderCompare() {
  const comps = D.comparisons || [];
  if (!comps.length) {
    $('#main').innerHTML = `<div class="empty">No environment comparison yet.<br>Open <b>Run tests</b>, choose <b>Both (compare)</b> and start a run. The report will appear here.<br>
      <span class="mute">The sandbox must be reachable from this machine (VPN or network access may be needed).</span></div>`;
    return;
  }
  const prods = [...new Set(comps.map((c) => c.product))];
  if (!prods.includes(S.cmpProduct)) S.cmpProduct = prods[0];
  const list = comps.filter((c) => c.product === S.cmpProduct).slice().reverse();
  const c = list.find((x) => x.runId === S.cmpRun) || list[0];
  const m = c.summary, A = c.envA.label, B = c.envB.label;
  const w = m.different || m.incomplete ? 'fail' : m.minor ? 'warn' : 'pass';
  const top = topDifferences(c, 12);

  const cmpCols = '--cols:minmax(220px,1.7fr) 150px 100px 100px 150px';
  const rows = c.scenarios.map((s, i) => {
    const id = 'c' + i;
    const flowCls = s.flow.length ? 'fail' : 'pass', dataCls = s.facts.length ? 'fail' : 'pass';
    return `<button class="gt-row" data-c="${id}" aria-expanded="false"><span class="name" title="${esc(s.scenario)}"><span class="chev" aria-hidden="true">▸</span> ${esc(s.scenario.replace(/^scenario-/, ''))}</span>
      <span><span class="pill ${verdictClass[s.overall]}">${verdictLabel[s.overall]}</span></span>
      <span class="hide-s"><span class="pill ${flowCls}">${s.flow.length ? s.flow.length + ' diff' : 'Same'}</span></span>
      <span class="hide-s"><span class="pill ${dataCls}">${s.facts.length ? s.facts.length + ' diff' : 'Same'}</span></span>
      <span><span class="pill ${verdictClass[s.designVerdict]}">${verdictLabel[s.designVerdict]}</span></span></button>
      <div class="cmp-detail" id="${id}" hidden>
      ${s.errorA || s.errorB ? `<div class="err">${esc(A)}: ${esc(s.errorA || 'ok')}\n${esc(B)}: ${esc(s.errorB || 'ok')}</div>` : ''}
      <p><b>Flow</b> (steps reached, order, page paths, where it ended)</p>${s.flow.length ? `<ul>${s.flow.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '<p class="mute">Same steps in the same order.</p>'}
      <p><b>Data</b> (plans offered, prices, totals)</p>${s.facts.length ? `<table class="mini"><thead><tr><th></th><th>${esc(A)}</th><th>${esc(B)}</th></tr></thead><tbody>${s.facts.map((f) => `<tr><td>${esc(f.key)}</td><td>${esc(f.a)}</td><td>${esc(f.b)}</td></tr>`).join('')}</tbody></table>` : '<p class="mute">Same plans, prices and totals.</p>'}
      <p><b>Design</b> by step (click a step for screenshots and details)</p>${s.design.map((st) => designStep(st, A, B)).join('')}</div>`;
  }).join('');

  $('#main').innerHTML = `
    <div class="picker" role="group" aria-label="Product">${prods.map((id) => `<button data-cp="${id}" aria-pressed="${id === S.cmpProduct}">${esc(comps.find((x) => x.product === id).productName)}</button>`).join('')}</div>
    <div class="banner ${w}">${esc(A)} vs ${esc(B)}: ${m.different || m.incomplete ? `${m.different + m.incomplete} of ${m.scenarios} scenario(s) differ or did not complete` : m.minor ? `${m.minor} of ${m.scenarios} scenario(s) have minor design differences` : `all ${m.scenarios} scenario(s) match`}</div>
    <section><h2>Summary report <span class="pill custom">${esc(c.runId)}</span></h2>
      <p class="mute" style="margin:0 0 8px">${esc(A)}: ${esc(c.envA.baseUrl)}<br>${esc(B)}: ${esc(c.envB.baseUrl)}</p>
      <div class="tiles">
        <div class="tile"><b>${m.scenarios}</b><span>scenarios compared</span></div>
        <div class="tile pass"><b>${m.identical}</b><span>identical</span></div>
        <div class="tile warn"><b>${m.minor}</b><span>minor design</span></div>
        <div class="tile fail"><b>${m.different}</b><span>different</span></div>
        <div class="tile"><b>${m.incomplete}</b><span>incomplete</span></div>
      </div>
      <div class="kv" style="margin-top:8px"><span>Flow differences <b>${m.flowDifferent}</b></span><span>Data differences <b>${m.factsDifferent}</b></span><span>Design differences <b>${m.designDifferent}</b> (${m.designMinor} minor)</span></div>
      ${top.length ? `<p><b>Main differences</b></p><ul>${top.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p>No differences found between the two environments.</p>'}
      <div class="actions"><button class="btn" id="copysum">Copy summary</button>${S.live ? `<a class="btn" href="${esc(c.reportPath)}" target="_blank">Open full report (.md)</a>` : ''}</div>
      <p class="mute" style="margin:8px 0 0">Under 0.5% of pixels different counts as identical and under 5% as minor; a page height gap under 3% is ignored and over 15% counts as different. Animated regions are masked. Dates, prices and rotating content can still cause small differences.</p></section>
    <div class="panel"><h2>Scenarios <button class="btn" id="cmpall" style="margin-left:auto;padding:4px 8px">Expand all</button></h2><div class="gt t-cmp" style="${cmpCols}"><div class="gt-head"><span>Scenario</span><span>Overall</span><span class="hide-s">Flow</span><span class="hide-s">Data</span><span>Design</span></div>${rows}</div></div>
    ${list.length > 1 ? `<section><h2>Earlier comparisons</h2><table><tbody>${list.map((x) => `<tr class="row" data-cr="${x.runId}"><td>${esc(x.runId)}</td><td>${fmtT(x.startedAt)}</td><td>${x.summary.identical}/${x.summary.scenarios} identical</td></tr>`).join('')}</tbody></table></section>` : ''}`;
  document.querySelectorAll('[data-cp]').forEach((b) => (b.onclick = () => { S.cmpProduct = b.dataset.cp; S.cmpRun = null; renderCompare(); toast('Showing ' + b.textContent); }));
  document.querySelectorAll('.gt-row[data-c]').forEach((b) => (b.onclick = () => { const d = document.getElementById(b.dataset.c); d.hidden = !d.hidden; b.setAttribute('aria-expanded', String(!d.hidden)); b.querySelector('.chev').textContent = d.hidden ? '▸' : '▾'; if (!d.hidden) focusOn(b); }));
  const first = document.querySelector('.gt-row[data-c]'); const tog = $('#cmpall');
  if (tog) tog.onclick = () => { const open = tog.dataset.open !== '1'; document.querySelectorAll('.gt-row[data-c]').forEach((b) => { const d = document.getElementById(b.dataset.c); d.hidden = !open; b.setAttribute('aria-expanded', String(open)); b.querySelector('.chev').textContent = open ? '▾' : '▸'; }); tog.dataset.open = open ? '1' : ''; tog.textContent = open ? 'Collapse all' : 'Expand all'; };
  void first;
  document.querySelectorAll('tr[data-cr]').forEach((tr) => (tr.onclick = () => { S.cmpRun = tr.dataset.cr; renderCompare(); scrollTo({ top: 0, behavior: 'smooth' }); }));
  $('#copysum').onclick = () => copyText(summaryText(c));
}

// ---------- dummy data generators (Malaysian citizen aged 18-59) ----------
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const pad = (n, l = 2) => String(n).padStart(l, '0');
const NAMES = {
  male: ['AHMAD', 'MUHAMMAD', 'MOHD', 'AIMAN', 'FARHAN', 'HAFIZ', 'IZZAT', 'DANIEL', 'HAKIM', 'IRFAN', 'SYAFIQ', 'ZAFRAN'],
  female: ['NUR', 'SITI', 'AISYAH', 'NURUL', 'FARAH', 'HANIS', 'IZZATI', 'SYAZWANI', 'AMIRAH', 'BALQIS'],
  second: ['ADAM', 'AMIR', 'HAZIQ', 'DANISH', 'ARIF', 'IKMAL', 'FATIN', 'AINA', 'NABILA', 'SOFEA', 'QISTINA', 'AFIQ'],
  father: ['AZLAN', 'RAZAK', 'HASSAN', 'ISMAIL', 'KAMARUDDIN', 'ROSLI', 'SULAIMAN', 'YUSOF', 'ZAKARIA', 'OSMAN'],
};
const STREETS = ['Jalan Mawar', 'Jalan Melati', 'Jalan Kenanga', 'Jalan Seroja', 'Jalan Cempaka', 'Jalan Dahlia'];
const TAMAN = ['Taman Mawar', 'Taman Melati', 'Taman Bunga Raya', 'Taman Sri Indah', 'Taman Harmoni', 'Taman Desa'];
const POSTCODES = ['43000', '47500', '40000', '50450', '80000', '10000', '30000', '75000'];

function randomPerson() {
  const male = Math.random() < 0.5;
  const age = 19 + rnd(41); // 19-59, so the real age is always within 18-60
  const now = new Date();
  const yy = (now.getFullYear() - age) % 100;
  const first = pick(male ? NAMES.male : NAMES.female), second = pick(NAMES.second), father = pick(NAMES.father);
  const last = pick(male ? [1, 3, 5, 7, 9] : [0, 2, 4, 6, 8]); // odd = male, even = female
  const flight = pick(['MH', 'AK', 'SQ']) + (100 + rnd(800));
  return {
    name: `${first} ${second} ${male ? 'BIN' : 'BINTI'} ${father}`,
    nric: pad(yy) + pad(1 + rnd(12)) + pad(1 + rnd(28)) + pad(1 + rnd(16)) + pad(rnd(1000), 3) + last,
    email: `${first.toLowerCase()}.${father.toLowerCase()}${100 + rnd(900)}@example.com`,
    mobile: '01' + pick([1, 2, 3, 4, 6, 7, 9]) + pad(rnd(10000000), 7),
    address1: `No. ${1 + rnd(60)} ${pick(STREETS)} ${1 + rnd(9)}`,
    address2: pick(TAMAN),
    postcode: pick(POSTCODES),
    flightOut: flight,
    flightBack: flight.slice(0, 2) + (Number(flight.slice(2)) + 1),
    tin: 'IG' + pad(rnd(100000000000), 11),
    plate: pick(['ZQ', 'ZX', 'QZ', 'XZ']) + pick(['A', 'B', 'K', 'W']) + (1000 + rnd(9000)),
  };
}

function randomise(m, model) {
  const person = randomPerson();
  for (const f of m.participantFields || []) {
    const v = { name: person.name, nric: person.nric, email: person.email, mobile: person.mobile, address1: person.address1,
      address2: person.address2, postcode: person.postcode, flightOut: person.flightOut, flightBack: person.flightBack, tin: person.tin }[f.gen];
    if (v !== undefined) model.participant[f.key] = v;
    else if (f.gen === 'pick') model.participant[f.key] = pick(f.options);
  }
  const prefix = { 'Air Asia': 'AK', 'Malaysia Airlines': 'MH' }[model.participant.carrier];
  if (prefix) for (const k of ['outboundNo', 'returnNo']) if (model.participant[k]) model.participant[k] = prefix + model.participant[k].replace(/^[A-Z]+/, '');
  for (const sc of model.scenarios) {
    for (const f of m.scenarioFields) {
      if (f.gen === 'pick') sc[f.key] = pick(f.options);
      else if (f.gen === 'range') { const [a, b] = f.genRange; sc[f.key] = a + rnd(b - a + 1); }
      else if (f.gen === 'nric') sc[f.key] = randomPerson().nric; // synthetic ID, fresh per scenario
      else if (f.gen === 'plate') sc[f.key] = randomPerson().plate;
    }
    for (const lim of m.limits || []) if (sc[lim.whenKey] === lim.whenValue && sc[lim.field] > lim.max) sc[lim.field] = lim.max;
  }
}

// ---------- run tests ----------
function freshModel(m) {
  return { scenarios: clone(m.defaultScenarios), participant: clone(m.defaultParticipant) };
}

function selectProduct(id) {
  S.product = id; S.errors = [];
  S.model = freshModel(S.manifests.find((m) => m.id === id));
}

function field(f, value, attr, disabled = false) {
  const hint = f.hint ? `<small>${esc(f.hint)}</small>` : '';
  const dis = disabled ? 'disabled' : '';
  const cls = f.wide ? 'wide' : ''; // long values (e.g. product names) get two columns
  if (f.type === 'select') {
    return `<label class="${cls}"><span class="lab">${esc(f.label)}</span><select ${attr} ${dis}>${f.options.map((o) => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>${hint}</label>`;
  }
  const t = f.type === 'number' ? `type="number" min="${f.min}" max="${f.max}"` : f.type === 'password' ? 'type="password"' : 'type="text"';
  return `<label class="${cls}"><span class="lab">${esc(f.label)}</span><input ${t} value="${esc(value)}" ${attr} ${dis} autocomplete="${f.type === 'password' ? 'new-password' : 'off'}"></label>`.replace('</label>', hint + '</label>');
}

function secretsCard(m, running) {
  const st = S.secrets[m.id];
  const saved = st?.saved && !S.editSecret;
  return `<section><h2>${esc(m.secretsTitle || 'Saved record')} ${st?.saved ? '<span class="pill pass">saved</span>' : '<span class="pill custom">none saved</span>'}</h2>
    <p class="mute" style="margin:0 0 8px">${esc(m.secretsHint || '')}</p>
    ${saved
      ? `<p style="margin:0">Saved: <b>${esc(st.summary)}</b> <span class="mute">(${esc(fmtT(st.savedAt))})</span></p>
         <div class="actions"><button class="btn" id="sec-edit" ${running ? 'disabled' : ''}>Replace</button><button class="btn" id="sec-del" ${running ? 'disabled' : ''}>Remove</button></div>`
      : `<div class="fgrid">${m.secretFields.map((f) => field(f, '', `data-sec="${f.key}"`)).join('')}</div>
         <div class="actions"><button class="btn primary" id="sec-save" ${running ? 'disabled' : ''}>Save record</button>${st?.saved ? '<button class="btn" id="sec-cancel">Cancel</button>' : ''}</div>`}
  </section>`;
}

async function secretsCall(method, product, body) {
  try {
    const r = await fetch('/api/secrets/' + product, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json();
    if (!r.ok) { S.errors = j.errors || ['Could not save the record']; return; }
    S.secrets = Object.fromEntries(j.map((x) => [x.product, x]));
    S.editSecret = false; S.errors = [];
  } catch { S.errors = ['The local server is not reachable. Is `npm run serve` still running?']; }
}

function wireSecrets(m) {
  const on = (id, fn) => { const el = $('#' + id); if (el) el.onclick = fn; };
  on('sec-edit', () => { S.editSecret = true; renderRun(); });
  on('sec-cancel', () => { S.editSecret = false; renderRun(); });
  on('sec-del', async () => { await secretsCall('DELETE', m.id); renderRun(); });
  on('sec-save', async () => {
    const body = {};
    document.querySelectorAll('[data-sec]').forEach((el) => (body[el.dataset.sec] = el.value));
    await secretsCall('PUT', m.id, body); // the typed values are not kept in the page after this
    renderRun();
  });
}

const runEnvList = () => (S.runEnv === 'both' ? D.envs.map((e) => e.id) : [S.runEnv]);

function renderRun() {
  const main = $('#main');
  if (!S.live) {
    main.innerHTML = `<section><h2>Run tests</h2><p>Starting tests needs the local control panel, because a web page cannot launch a browser by itself.</p>
      <p>In a terminal, from the project folder, run:</p><p><code id="cmd">npm run serve</code> <button class="btn" id="copy">Copy</button></p>
      <p class="mute">Then open <b>http://127.0.0.1:4317</b>. The Run tests tab lists every product that has a <code>tests/&lt;product&gt;/product.json</code>, loaded with default scenarios you can edit or randomise, and runs them on Production, Sandbox, or both for a comparison.</p></section>`;
    $('#copy').onclick = () => copyText('npm run serve');
    return;
  }
  if (!S.manifests.length) { main.innerHTML = '<div class="empty">No products found. Add <code>tests/&lt;product&gt;/product.json</code>.</div>'; return; }
  if (!S.product) selectProduct(S.manifests[0].id);
  const m = S.manifests.find((x) => x.id === S.product), md = S.model;
  const running = S.run?.state === 'running';
  const est = Math.ceil((md.scenarios.length * m.estSecondsPerScenario * runEnvList().length) / 60);
  const envOpts = [...D.envs.map((e) => [e.id, e.label]), ['both', 'Both (compare)']];

  main.innerHTML = `
    <div class="picker" role="group" aria-label="Product">${S.manifests.map((x) => `<button data-prod="${x.id}" aria-pressed="${x.id === S.product}" ${running ? 'disabled' : ''}>${esc(x.name)}</button>`).join('')}</div>
    <section><h2>Environment</h2>
      <div class="picker" role="group" aria-label="Environment" style="margin:0">${envOpts.map(([id, t]) => `<button data-renv="${id}" aria-pressed="${S.runEnv === id}" ${running ? 'disabled' : ''}>${esc(t)}</button>`).join('')}</div>
      <p class="mute" style="margin:8px 0 0">${S.runEnv === 'both' ? 'Runs the same data on both environments, then builds a flow, data and design comparison.' : esc(D.envs.find((e) => e.id === S.runEnv)?.baseUrl || '')}</p></section>
    <section><h2>${esc(m.name)}</h2><p class="mute" style="margin:0">${esc(m.description || '')}</p>
      <div class="actions"><button class="btn" id="rand" ${running ? 'disabled' : ''}>Randomise dummy data</button><button class="btn" id="reset" ${running ? 'disabled' : ''}>Reset to defaults</button></div></section>
    ${m.secretFields ? secretsCard(m, running) : ''}
    <section><h2>Scenarios <span class="pill custom">${md.scenarios.length}</span></h2>
      ${md.scenarios.map((sc, i) => `<div class="sc"><div class="sc-h"><span>Scenario ${i + 1}</span>
        <button class="btn" data-del="${i}" ${running || md.scenarios.length < 2 ? 'disabled' : ''}>Remove</button></div>
        <div class="fgrid">${m.scenarioFields.map((f) => field(f, sc[f.key], `data-s="${i}" data-k="${f.key}"`, !!f.ignoredWhen && String(sc[f.ignoredWhen.key] ?? '').startsWith(f.ignoredWhen.startsWith))).join('')}</div></div>`).join('')}
      <div class="actions"><button class="btn" id="add" ${running || md.scenarios.length >= m.maxScenarios ? 'disabled' : ''}>Add scenario</button></div></section>
    ${(m.participantFields || []).length ? `<section><h2>${esc(m.participantTitle || 'Participant, flight and tax details')}</h2>
      <div class="fgrid">${m.participantFields.map((f) => field(f, md.participant[f.key], `data-p="${f.key}"`)).join('')}</div></section>` : ''}
    ${S.errors.length ? `<div class="errs"><b>Fix before starting</b><ul>${S.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
    <div class="actions runbar"><button class="btn primary" id="start" ${running || S.starting ? 'disabled' : ''}>${running ? 'Running...' : 'Start tests'}</button>
      <span class="mute">About ${est} min for ${md.scenarios.length} scenario(s) on ${runEnvList().map(envLabel).join(' and ')}. Stops on the Summary page, before payment.</span></div>
    <div id="live"></div>`;

  document.querySelectorAll('[data-prod]').forEach((b) => (b.onclick = () => { selectProduct(b.dataset.prod); renderRun(); toast(b.textContent + ' ready with default data'); }));
  document.querySelectorAll('[data-renv]').forEach((b) => (b.onclick = () => { S.runEnv = b.dataset.renv; renderRun(); }));
  document.querySelectorAll('[data-s]').forEach((el) => (el.oninput = el.onchange = () => {
    const f = m.scenarioFields.find((x) => x.key === el.dataset.k);
    md.scenarios[+el.dataset.s][el.dataset.k] = f.type === 'number' ? Number(el.value) : el.value;
    if (m.scenarioFields.some((x) => x.ignoredWhen?.key === el.dataset.k) && el.tagName === 'SELECT') renderRun(); // greys out dependent fields
  }));
  wireSecrets(m);
  document.querySelectorAll('[data-p]').forEach((el) => (el.oninput = el.onchange = () => { md.participant[el.dataset.p] = el.value; }));
  document.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { md.scenarios.splice(+b.dataset.del, 1); renderRun(); }));
  $('#add').onclick = () => { md.scenarios.push(clone(md.scenarios.at(-1))); renderRun(); toast('Scenario added'); focusOn([...document.querySelectorAll('.sc')].at(-1)); };
  $('#rand').onclick = () => { randomise(m, md); S.errors = []; renderRun(); toast('New dummy data generated'); focusOn(document.querySelector('.sc')); };
  $('#reset').onclick = () => { S.model = freshModel(m); S.errors = []; renderRun(); toast('Reset to the default data'); };
  $('#start').onclick = start;
  liveRun();
}

async function start() {
  S.starting = true; S.errors = [];
  try {
    const r = await fetch('/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: S.product, envs: runEnvList(), ...S.model }) });
    const j = await r.json();
    if (!r.ok) S.errors = j.errors || ['Could not start the run'];
  } catch { S.errors = ['The local server is not reachable. Is `npm run serve` still running?']; }
  S.starting = false;
  await poll();
  renderRun();
  if (!S.errors.length) { startPolling(); toast('Tests started'); focusOn($('#live')); }
  else focusOn(document.querySelector('.errs'));
}

function startPolling() {
  clearInterval(S.timer);
  S.timer = setInterval(async () => { await poll(); if (S.view === 'run') liveRun(); if (S.run?.state !== 'running') { clearInterval(S.timer); S.timer = null; await finish(); } }, 2000);
}

async function poll() {
  try { S.run = await (await fetch('/api/runs/current', { cache: 'no-store' })).json(); } catch { /* keep last state */ }
}

async function finish() {
  try { D = await (await fetch('data.json', { cache: 'no-store' })).json(); } catch { /* keep current data */ }
  if (S.view === 'run') renderRun();
}

function liveRun() {
  const box = $('#live');
  const r = S.run;
  if (!box || !r || r.state === 'idle') return;
  const pairs = r.envs.flatMap((env) => r.planned.map((id) => ({ env, id })));
  const nextUp = pairs.find((p) => !r.results.some((x) => x.env === p.env && x.scenario === p.id));
  const rows = pairs.map((p) => {
    const done = r.results.find((x) => x.env === p.env && x.scenario === p.id);
    const st = done ? done.status : (r.state === 'running' && nextUp && p.env === nextUp.env && p.id === nextUp.id ? 'running' : 'pending');
    return `<tr><td>${esc(envLabel(p.env))}</td><td>${esc(p.id)}</td><td><span class="pill ${st}">${st === 'pending' ? 'queued' : st}</span></td><td>${done ? fmtMs(done.durationMs) : ''}</td></tr>`;
  }).join('');
  const label2 = { running: 'Running', done: 'Finished - all passed', failed: 'Finished - some failed' }[r.state];
  const both = r.envs.length > 1;
  box.innerHTML = `<section><h2>${esc(r.runId)} <span class="pill ${r.state === 'running' ? 'running' : r.state === 'done' ? 'passed' : 'failed'}">${label2}</span></h2>
    <table><thead><tr><th>Environment</th><th>Scenario</th><th>Status</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>
    <pre class="log" id="log">${esc(r.log.slice(-60).join('\n'))}</pre>
    ${r.state !== 'running' ? `<div class="actions"><button class="btn primary" id="open">${both ? 'Open comparison' : 'Open results in Monitor'}</button></div>` : ''}</section>`;
  const log = $('#log'); if (log) log.scrollTop = log.scrollHeight;
  const open = $('#open');
  if (open) open.onclick = () => {
    if (both) { S.view = 'compare'; S.cmpProduct = r.product; S.cmpRun = r.runId; }
    else { S.view = 'monitor'; S.env = r.envs[0]; S.selected = (D.products.find((p) => p.runs.some((x) => x.runId === r.runId))?.id) ?? S.selected; S.openRun = { suite: r.product, runId: r.runId }; }
    render(); scrollTo({ top: 0 });
  };
}

// ---------- boot ----------
async function probe() {
  try {
    const res = await fetch('/api/products', { cache: 'no-store' });
    if (!res.ok) return;
    S.manifests = await res.json();
    S.live = true;
    try { S.secrets = Object.fromEntries((await (await fetch('/api/secrets', { cache: 'no-store' })).json()).map((x) => [x.product, x])); } catch { /* none saved */ }
    try { D = await (await fetch('data.json', { cache: 'no-store' })).json(); } catch { /* embedded data is fine */ }
    await poll();
    if (S.run?.state === 'running') startPolling();
  } catch { /* opened as a file or from a host without the server */ }
}


// ---------- insights: what the test runs say about speed, effort and risk ----------
// Journey measures come from the latest regular run's logs. The notes below are written from the runs of 2 Oct 2026;
// they are suggestions to discuss with the product, security and compliance owners, not audit findings.
const INSIGHT_NOTES = [
  { pri: 'High', line: 'Health & Medical', title: 'The occupation/income list fails to load on every run',
    seen: 'GET /api/v1/refs/hib/salaries returns 400 (Bad Request) in each Health (HIB) run, with a console error from the app next to it.',
    idea: 'Check whether customers see an empty or stuck list at that step. Return the list, or show a clear message with a retry.',
    guard: 'Keep the validation on the server. Do not loosen it to make the call pass.' },
  { pri: 'High', line: 'Hibah & Protection', title: 'Basic Term asks for the most before showing a price: 32 entries over 6 pages',
    seen: 'The participant page blocked on address, tax (e-invoice), MSIC and bank account details. The employer address repeats the mailing address fields.',
    idea: 'Add "same as mailing address" for the employer address. Ask for bank account details only after the customer decides to buy (they are for refund or claim payment). Make the tax and MSIC answers default to "No" with a short explanation.',
    guard: 'Collecting bank details later means less sensitive data is held for people who never buy. Keep the account number masked on screen and encrypted at rest, and have compliance confirm which fields are mandatory before issuing the policy.' },
  { pri: 'High', line: 'Home', title: 'Home: a long wait after "Continue" on the participant page',
    seen: 'The Summary appeared about 53 seconds after pressing Continue (see the table). The page logs "No customer found" and "Unable to retrieve TIN number information" as errors, which are normal for a new customer.',
    idea: 'Show progress with an expected time while the customer is checked, run the TIN and customer lookups in parallel or after the Summary, and treat "no customer found" as a normal result so real errors stand out.',
    guard: 'Do not cache customer lookups in the browser. Keep rate limits on the ID lookup so the form cannot be used to check whether someone is a customer.' },
  { pri: 'Medium', line: 'Car and Motorcycle', title: 'The renewal lookup shows a raw technical error when the service is slow',
    seen: 'One saved-record run showed "RequestError: Timeout: Request failed to complete in 15000ms" in a pop-up. A retry then worked.',
    idea: 'Replace it with a plain message ("We could not reach the service. Try again.") and a Try again button. Retry once automatically.',
    guard: 'Keep the wording identical for "not found" and "mismatch" cases so it cannot reveal whether a vehicle or ID exists.' },
  { pri: 'High', line: 'Health & Medical', title: 'Each Continue in the HIB journey takes about 18 seconds',
    seen: 'On the participant steps, pressing Continue took 17 to 20 seconds to show the next step, three times in a row (about 55 seconds in total).',
    idea: 'Find what each step waits for. If each step reloads the same data, load it once. Show progress while waiting.',
    guard: 'Do not skip the server-side checks to save time; remove repeated calls instead.' },
  { pri: 'Medium', line: 'Health & Medical', title: 'Three consecutive steps share one URL and have no page title',
    seen: 'HIB steps 3, 4 and 5 are all /direct/hib/participant-details with an empty title. Personal Accident step 2 also has an empty title.',
    idea: 'Give each step its own address and title. The browser Back button, screen readers and funnel analytics then all work step by step.',
    guard: 'Keep step addresses free of personal data and tokens.' },
  { pri: 'Medium', line: 'All products', title: 'Console errors are frequent enough to hide real ones',
    seen: 'Seen on recent runs: "reinitBot: window not found" on the main site, "Params incomplete" on Personal Accident, and (on 1 Oct) analytics calls to third-party hosts blocked by the page\'s own security policy plus a 400 on Travel participant details.',
    idea: 'Clear the known noise so any new error is a signal. Check that the blocked analytics hosts are approved, and either allow them in the policy or remove the calls.',
    guard: 'Do not weaken the Content Security Policy to silence errors. Add only hosts that the data owner has approved.' },
  { pri: 'Medium', line: 'Travel', title: 'Two Kembara entry links point at a host this network cannot reach',
    seen: 'digital.takaful-ikhlas.com.my/epolicy/index.cfm refuses the connection from here on every run.',
    idea: 'Confirm from a public network whether customers can reach it. If it is internal only, the public site should not link to it.',
    guard: 'If it is meant to be internal, check that it is not exposed to the internet by mistake.' },
  { pri: 'High', line: 'Travel', title: 'Travel journeys fail at random on desktop today',
    seen: 'On 6 Oct the 6 Travel scenarios were run four times. Each time 2 or 3 failed, at a different step: the city did not fill after the postcode, the plan list did not appear, or the Summary did not finish loading. On 2 Oct all 6 passed. At phone size all 6 passed.',
    idea: 'Check the postcode-to-city lookup and the plan list for slow or failed responses around those times, and compare with the service logs. The test was changed to retry the e-invoice click and still failed elsewhere, so the cause is probably the site or its network, not one test step. This is not confirmed.',
    guard: 'Do not hide it by adding longer waits to the monitor. An intermittent failure here may be what customers see too.' },
  { pri: 'Medium', line: 'Health & Medical', title: 'HIB on a phone: sideways scrolling and no number keyboard',
    seen: 'On 4 of 14 phone screens in the HIB journey the page was wider than the phone. The ID, mobile number, postcode and bank account boxes do not ask for a number keyboard. Many text boxes are under 16 px.',
    idea: 'Fix the layout that overflows, set the input type or inputmode on those boxes (numeric for ID, mobile, postcode and account), and use at least 16 px text so iPhones do not zoom in on tap.',
    guard: 'Keep account numbers masked on screen after entry.' },
  { pri: 'Medium', line: 'All products', title: 'The chat assistant sits on top of the Get Quote button on phones',
    seen: 'On the Travel and Basic Term category pages at phone size, the floating assistant avatar overlaps the Get Quote button and an "IVA" pop-up covers the card below it. On desktop, the assistant window opened by itself over the product page in one run.',
    idea: 'Start the assistant closed on product pages, keep it clear of the main button, and make sure it does not open over the first screen of a journey.',
    guard: 'Keep the chat provider\'s data handling and consent wording in line with the privacy notice.' },
  { pri: 'Governance', line: 'All products', title: 'Test journeys create real quotation records in production',
    seen: 'Every Basic Term, HIB, Home and Personal Accident run submits a new dummy person (example.com email, generated ID).',
    idea: 'Agree a reserved set of test IDs and a name prefix with the business so these records can be filtered out of reports and purged. Run the journeys on the sandbox once it is reachable from this network.',
    guard: 'Generated ID numbers look valid and could belong to a real person. A reserved test range avoids that. Genuine records used for Motor must stay company-owned, which the dashboard already keeps on this machine only.' },
  { pri: 'High', line: 'Personal Accident', title: 'Personal Accident is slow to start, and slow to finish on the English-labelled plans',
    seen: 'On all 6 plans the participant page took about 17 seconds to appear after pressing Subscribe. After saving, the Summary came in about 2 seconds on the four Malay plans (Melindungi, Bekerja, Membantu, Merawat) but about 52 seconds on Permata and Perdana, which use English labels.',
    idea: 'Find out why Permata and Perdana take 25 times longer to produce the Summary (a different back-end call is the first thing to check) and why the first step takes 17 seconds. Show progress while waiting.',
    guard: 'Keep the same validation on both plan types so the faster path is not the less checked one.' },
  { pri: 'Good', line: 'Hibah & Protection', title: 'Basic Term pages respond quickly; the cost is effort, not waiting',
    seen: 'Across 6 pages the site needed under 14 seconds in total to show the next page, but customers must complete 32 entries.',
    idea: 'Cutting entries (see the Basic Term note above) will make this the fastest long journey without any back-end work.',
    guard: '' },
];


// ---------- funnel design recommendations (insurance benchmark) ----------
// "ours" comes from the test screenshots and logs of 2 Oct 2026. Benchmarks are from the linked public pages, which describe each
// insurer's marketing page or published guidance; we did not walk through the competitors' own purchase screens.
const SRC = {
  baymard: ['Baymard: checkout form fields', 'https://baymard.com/blog/checkout-optimization-from-16-fields-to-8'],
  baymardFlow: ['Baymard: checkout flow UX', 'https://baymard.com/blog/checkout-flow-ux-optimization'],
  lion: ['Lion+Mason: insurance quote and buy journeys', 'https://lionandmason.com/insights/creating-engaging-and-high-performing-ux-for-insurance-quote-and-buy-journeys/'],
  cart: ['ConvertCart: insurance conversion ideas', 'https://www.convertcart.com/blog/insurance-conversion-rate-optimization'],
  zurich: ['Zurich Takaful renewal (Paultan)', 'https://paultan.org/insurance/zurich-takaful/'],
  ge: ['Great Eastern Takaful online', 'https://www.greateasterntakaful.com/en/personal-takaful/our-products/get-it-direct.html'],
  etiqa: ['Etiqa travel', 'https://www.etiqa.com.my/travel'],
};
const DESIGN_RECS = [
  { pri: 'High', title: 'Ask for less before the customer has a price',
    ours: 'Basic Term needs 32 entries on one participant page: contact, mailing address, employer and employer address, e-invoice and MSIC questions, then bank details. The employer address repeats the mailing address.',
    bench: 'Baymard finds the average checkout has about 11 form fields and that a guest checkout can work with 6 to 8. It recommends defaulting the second address to "same as" the first and using address lookup. Lion+Mason recommends minimal information up front, with later questions shaped by earlier answers.',
    do: 'Target 12 or fewer entries before the Summary. Add "same as mailing address", ask for employer details only when the occupation needs them, and default the e-invoice and MSIC answers to "No" with a one-line reason. Ask for bank details after the customer chooses to pay.',
    guard: 'Collecting less is also data minimisation under PDPA. Keep the e-invoice (LHDN) and MSIC questions where the regulation needs them, and confirm with compliance which fields are mandatory at quote and which at issuance.',
    src: ['baymard', 'lion'] },
  { pri: 'High', title: 'Say how long it takes, and show progress while the system works',
    ours: 'The stepper shows the steps, but no time promise. Waits seen: about 17 s per step on HIB, about 17 s after Subscribe on Personal Accident, and about 53 s after Continue on Home, with no wording that explains the wait.',
    bench: 'Zurich Takaful (via Paultan) states "under 5 minutes". ConvertCart advises progress indicators that tell people how close they are to a result and real-time error checks.',
    do: 'Put "About 3 minutes, 4 steps" on the first page of each funnel. For any wait over 3 seconds show what is happening ("Checking your details") and an expected time. Keep the Continue button disabled while it works so people do not press it twice.',
    guard: 'A double-submit can create duplicate records, so lock the button while the request runs.',
    src: ['zurich', 'cart'] },
  { pri: 'High', title: 'Let customers stop and come back',
    ours: 'No save-and-resume or "email me this quote" was seen in any journey we walked. Each test starts from a blank form.',
    bench: 'ConvertCart reports an agency that added "Save and Continue" and saw less abandonment (a vendor case, not an independent study).',
    do: 'Offer "Email me my quote" and a resume link after the first price is shown. Keep the quote valid for a stated period and say so.',
    guard: 'Use a signed link that expires, no personal data in the address, and a one-time code before showing saved details. Resuming must not reveal whether someone is an existing customer.',
    src: ['cart'] },
  { pri: 'Medium', title: 'Make help visible inside the funnel',
    ours: 'In the screens we captured, the funnel pages show only a logo, the stepper, and footer links (Disclaimer, Privacy, Terms, Sitemap). No phone, WhatsApp or chat was visible.',
    bench: 'Great Eastern Takaful lists a customer care number, an email and an advisor match form next to its online purchase. Etiqa lists customer care hours and a 24/7 overseas emergency number on its travel page. ConvertCart lists live chat and instant callback among the most effective tactics.',
    do: 'Add a small "Need help?" link on every step with the care number and hours, and a callback request on steps where people stall. Add the 24/7 overseas assistance number on the Travel Summary.',
    guard: 'Never put personal data into a chat transcript that is kept without consent. Do not let agents take card details over chat.',
    src: ['ge', 'etiqa', 'cart'] },
  { pri: 'Medium', title: 'Keep language consistent in each journey',
    ours: 'The Personal Accident (Malay) journey shows "Summary" in English in the stepper beside Malay labels such as "Butiran Peserta" and "Selesai". Some plans are English and others Malay for the same product.',
    bench: 'Lion+Mason recommends plain language in place of jargon.',
    do: 'Give every funnel a BM / EN switch that keeps the answers entered so far, and translate all labels, including the stepper and error messages.',
    guard: 'Legal wording (terms, declarations) must be the approved version in each language.',
    src: ['lion'] },
  { pri: 'Medium', title: 'Keep the price clear and say what is not covered',
    ours: 'Good: the side panel shows the contribution, discount (25%), service tax (8%) and total, and stays visible. Not seen on the pages we captured: a short list of key exclusions beside the price.',
    bench: 'ConvertCart: shoppers value transparency, and being upfront about exclusions reduces objections later. Zurich shows live quotes and the add-on prices in the same flow.',
    do: 'Add a "Key exclusions" link beside the total on the Summary and show the price from the first plan page. Show the total and the monthly amount together where a plan can be paid monthly.',
    guard: 'Wording on benefits and exclusions must match the approved product disclosure sheet.',
    src: ['cart', 'zurich'] },
  { pri: 'Medium', title: 'Review payment choice at the last step',
    ours: 'The motor page lists cards, FPX, Touch \'n Go, GrabPay, Boost, QR pay and ShopeePay. Our tests never go past the Summary, so the payment step itself is not reviewed.',
    bench: 'Zurich Takaful (via Paultan) adds instalments through Grab PayLater, Shopee SPayLater and Atome, subject to eligibility. ConvertCart says a range of payment options matters (a vendor claim).',
    do: 'Review the payment page by hand once, outside the automated tests. Consider instalments for higher contributions, if the business and compliance accept them.',
    guard: 'Buy-now-pay-later needs a compliance decision. Keep card data with the payment provider, and never have the tests enter payment details.',
    src: ['zurich', 'cart'] },
  { pri: 'Medium', title: 'Check the funnels on a phone',
    ours: 'All our runs use a desktop browser, so we have no evidence on mobile layout, keyboards, or autofill.',
    bench: 'Baymard recommends full browser autofill compatibility and address lookup, both of which matter most on phones.',
    do: 'Run each journey at a phone size. Check that the right keyboard appears (numeric for ID and mobile number), that autofill works, and that the Continue bar does not cover fields.',
    guard: 'Do not turn autofill off on personal fields to look safer. It lowers errors, and the browser keeps it local.',
    src: ['baymard', 'baymardFlow'] },
];

function journeyStats(run) {
  const rows = run.results.map((r) => {
    const t = (x) => Date.parse(x.ts);
    const pages = r.steps.filter((x) => /^Page \d+/.test(x.msg)).length;
    const entries = r.steps.filter((x) => /^\s+filled /.test(x.msg)).length;
    let wait = 0, slow = { s: 0, at: '' };
    r.steps.forEach((x, i) => {
      if (!/^\s+pressed "/.test(x.msg)) return;
      const next = r.steps.slice(i + 1).find((y) => /^Page \d+/.test(y.msg));
      if (!next) return;
      const dt = (t(next) - t(x)) / 1000;
      wait += dt;
      if (dt > slow.s) slow = { s: dt, at: next.msg.replace(/^Page \d+:\s*(Summary reached )?/, '').split('|')[0].trim() };
    });
    return { pages, entries, wait, slow, errs: r.httpErrors.length + r.consoleErrors.length };
  }).filter((x) => x.pages > 0);
  if (!rows.length) return null;
  const mid = (k) => rows.map((x) => x[k]).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  return { pages: mid('pages'), entries: mid('entries'), wait: mid('wait'), slow: rows.sort((a, b) => b.slow.s - a.slow.s)[0].slow, errs: Math.max(...rows.map((x) => x.errs)), n: run.results.length, durationS: run.durationMs / 1000 / run.results.length };
}

function renderInsights() {
  const v = S.insightView || 'perf';
  const seg = `<div class="filters" style="padding:0 0 8px" role="group" aria-label="Insights view"><button data-iv="perf" aria-pressed="${v === 'perf'}">Performance and fixes</button><button data-iv="design" aria-pressed="${v === 'design'}">Funnel design recommendations</button><button data-iv="phone" aria-pressed="${v === 'phone'}">Phone size</button></div>`;
  if (v === 'design') return renderDesignRecs(seg);
  if (v === 'phone') return renderPhone(seg);
  const rows = [];
  for (const p of D.products) for (const run of latestBySuite(p)) {
    const st = journeyStats(run);
    if (st) rows.push({ p, run, st });
  }
  const best = rows.slice().sort((a, b) => a.st.entries - b.st.entries)[0];
  const heavy = rows.slice().sort((a, b) => b.st.entries - a.st.entries)[0];
  const waitiest = rows.slice().sort((a, b) => b.st.wait - a.st.wait)[0];
  const cols = '--cols:minmax(150px,1.3fr) 70px 90px 130px minmax(120px,1fr) 80px';
  const body = rows.map(({ p, run, st }) => `<button class="gt-row" data-open="${p.id}" aria-label="Open ${esc(p.name)} results">
      <span class="name">${esc(p.name)} <span class="mute" style="font-weight:400;font-size:14px">${esc(run.suiteName)}</span></span>
      <span class="num">${st.pages}</span><span class="num">${st.entries}</span>
      <span class="num" title="Time from pressing the next button to the next page appearing, all steps added up">${fmtS(st.wait)}</span>
      <span title="Slowest single step">${fmtS(st.slow.s)} <span class="mute">${esc(st.slow.at.slice(0, 28))}</span></span>
      <span class="num ${st.errs ? 'stale' : ''}">${st.errs} <span class="chev" aria-hidden="true">›</span></span></button>`).join('');
  const tag = { High: 'fail', Medium: 'warn', Governance: 'custom', Good: 'pass' };
  const order = ['High', 'Medium', 'Governance', 'Good'];
  const idOf = (line) => D.products.find((q) => line.startsWith(q.name))?.id;
  const counts = Object.fromEntries(order.map((k) => [k, INSIGHT_NOTES.filter((n) => n.pri === k).length]));
  const notes = INSIGHT_NOTES.filter((n) => !S.insightPri || n.pri === S.insightPri).slice().sort((a, b) => order.indexOf(a.pri) - order.indexOf(b.pri)).map((n) => `<article class="panel" style="margin-top:8px"><h2><span class="pill ${tag[n.pri]}">${n.pri}</span>${esc(n.title)}<span class="chip">${esc(n.line)}</span></h2>
      <div class="panel-pad" style="display:grid;gap:8px;padding-top:8px">
        <div><b>What the tests saw.</b> ${esc(n.seen)}</div>
        <div><b>Suggestion.</b> ${esc(n.idea)}</div>
        ${n.guard ? `<div class="mute"><b>Security and governance.</b> ${esc(n.guard)}</div>` : ''}
        ${idOf(n.line) ? `<div><button class="btn" data-open="${idOf(n.line)}">See ${esc(D.products.find((q) => q.id === idOf(n.line)).name)} results ›</button></div>` : ''}</div></article>`).join('');
  $('#main').innerHTML = seg + `
    <div class="strip pass"><div><h2>Where customers spend effort</h2>
      <div class="why">${heavy ? `Most to fill in: ${esc(heavy.p.name)} (${heavy.st.entries} entries). ` : ''}${best ? `Least: ${esc(best.p.name)} (${best.st.entries}). ` : ''}${waitiest ? `Longest wait after pressing next: ${esc(waitiest.p.name)} (${fmtS(waitiest.st.wait)}).` : ''}</div></div></div>
    <div class="panel"><h2>Journey effort <span class="chip">${esc(envLabel('production'))}</span><span class="chip">latest regular run</span></h2>
      <div class="sub2">Measured from the test logs, up to the Summary page. Entries are the fields the test had to fill. Wait is the time the site took to show the next page; it does not include typing time.</div>
      <div class="gt" style="${cols}"><div class="gt-head"><span>Journey</span><span class="r">Pages</span><span class="r">Entries</span><span class="r">Wait total</span><span>Slowest step (worst plan)</span><span class="r">Errors</span></div>${body || '<div class="gt-row" style="cursor:default"><span class="mute">No journey runs yet.</span></div>'}</div></div>
    <h3 id="notes" style="margin:24px 0 0;font-size:16px">Notes and suggestions</h3>
    <div class="filters" style="padding:8px 0 0" role="group" aria-label="Filter notes by priority"><button data-ip="" aria-pressed="${!S.insightPri}">All ${INSIGHT_NOTES.length}</button>${order.map((k) => `<button data-ip="${k}" aria-pressed="${S.insightPri === k}">${k} ${counts[k]}</button>`).join('')}</div>
    <p class="mute" style="margin:4px 0 0">Written from the runs of 2 Oct 2026. They are suggestions to take to the product, security and compliance owners.</p>
    ${notes}
    <div class="panel" style="margin-top:16px"><h2>What these tests cannot tell you</h2><div class="panel-pad"><ul style="margin:0;padding-left:16px;display:grid;gap:4px">
      <li>How many real customers start and finish each journey, or where they drop out. That needs the analytics numbers.</li>
      <li>How it feels on a phone or a slow connection. Tests run on a desktop browser on a fast network.</li>
      <li>Whether the site is secure. The tests only watch behaviour on the surface and never press payment. A proper security review is separate.</li>
      <li>Timing is indicative: it includes the test's own short pauses.</li></ul></div></div>`;
  document.querySelectorAll('[data-iv]').forEach((b) => (b.onclick = () => { S.insightView = b.dataset.iv; renderInsights(); scrollTo({ top: 0 }); }));
  document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openProduct(b.dataset.open)));
  document.querySelectorAll('[data-ip]').forEach((b) => (b.onclick = () => { S.insightPri = b.dataset.ip || null; renderInsights(); focusOn($('#notes')); }));
}


function phoneStats(run) {
  const shots = run.results.flatMap((r) => Object.values(r.mobile ?? {}));
  const uniq = (k) => [...new Set(shots.flatMap((x) => x[k] ?? []))].filter(Boolean);
  return {
    pages: shots.length,
    overflow: shots.filter((x) => x.overflowX).length,
    overflowMax: Math.max(0, ...shots.map((x) => x.overflowBy ?? 0)),
    small: Math.max(0, ...shots.map((x) => x.smallTargetCount ?? 0)),
    smallNames: uniq('smallTargets'),
    tight: Math.max(0, ...shots.map((x) => x.tightTargets ?? 0)),
    smallText: uniq('smallTextInputs'), noHint: uniq('inputsWithoutKeyboardHint'), noAuto: uniq('inputsWithoutAutocomplete'),
    bar: Math.max(0, ...shots.map((x) => ((x.fixedBarPercent ?? 0) > 60 ? 0 : (x.fixedBarPercent ?? 0)))), // anything over 60% of the screen is a loading overlay or pop-up, not a button bar
    width: shots[0]?.width,
  };
}

function renderPhone(seg) {
  const rows = [];
  for (const p of D.products) for (const id of suitesOf(p)) {
    const run = envRuns(p).filter((r) => r.suite === id && r.device === 'mobile').at(-1);
    if (!run) continue;
    const desk = basis(p).filter((r) => r.suite === id && r.device !== 'mobile').at(-1);
    rows.push({ p, run, desk, st: phoneStats(run) });
  }
  const cols = '--cols:minmax(150px,1.2fr) 90px 110px 110px 120px 90px 90px';
  const body = rows.map(({ p, run, desk, st }) => `<button class="gt-row" data-open="${p.id}" aria-label="Open ${esc(p.name)} results">
      <span class="name">${esc(p.name)} <span class="mute" style="font-weight:400;font-size:14px">${esc(run.suiteName)}</span></span>
      <span><span class="pill ${run.health}">${run.passed}/${run.total}</span></span>
      <span class="num ${st.overflow ? 'stale' : ''}" title="Screens that scroll sideways">${st.overflow} of ${st.pages}</span>
      <span class="num ${st.small ? 'stale' : ''}" title="Worst screen: tap targets under 24 px (WCAG 2.2 minimum)">${st.small}</span>
      <span class="num ${st.noHint.length ? 'stale' : ''}" title="${esc(st.noHint.join(', '))}">${st.noHint.length}</span>
      <span class="num ${st.smallText.length ? 'stale' : ''}" title="${esc(st.smallText.join(', '))}">${st.smallText.length}</span>
      <span class="num">${st.bar}% <span class="chev" aria-hidden="true">›</span></span></button>`).join('');
  const total = rows.reduce((a, x) => ({ ok: a.ok + x.run.passed, n: a.n + x.run.total }), { ok: 0, n: 0 });
  const issues = rows.filter((x) => x.st.overflow || x.st.small || x.st.noHint.length || x.st.smallText.length);
  const list = (title, key, hint) => {
    const all = rows.flatMap((x) => x.st[key].map((n) => `${x.p.name}: ${n}`));
    return all.length ? `<div class="panel" style="margin-top:8px"><h2>${title} <span class="chip">${all.length}</span></h2><div class="panel-pad"><div class="sub2" style="padding:0 0 8px">${hint}</div><ul style="margin:0;padding-left:16px;display:grid;gap:2px">${all.slice(0, 24).map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div></div>` : '';
  };
  $('#main').innerHTML = seg + (rows.length ? `
    <div class="strip ${total.ok === total.n ? 'pass' : 'fail'}"><div><h2>${total.ok} of ${total.n} journeys completed on a phone</h2>
      <div class="why">Pixel 7 size (${rows[0].st.width ?? 412} px wide), Production. ${issues.length ? `${issues.length} of ${rows.length} suites have layout points to look at.` : 'No layout points found.'} ${esc(fmtT(rows[0].run.startedAt))}</div></div></div>
    <div class="panel"><h2>Phone-size checks <span class="chip">${esc(envLabel('production'))}</span></h2>
      <div class="sub2">Taller columns mean more to fix. The checks are automatic and cover layout, tap size and keyboard hints, not how it feels to use. Click a row for its steps and phone screenshots.</div>
      <div class="gt" style="${cols}"><div class="gt-head"><span>Journey</span><span>Completed</span><span class="r">Sideways scroll</span><span class="r">Small taps</span><span class="r">No key hint</span><span class="r">Zoom text</span><span class="r">Sticky bar</span></div>${body}</div>
      <div class="legend" style="display:block"><span><b>Sideways scroll</b>: screens wider than the phone.</span> <span><b>Small taps</b>: buttons or links under 24 px, the WCAG 2.2 minimum (links inside sentences are exempt).</span> <span><b>No key hint</b>: ID, phone, email or postcode boxes that do not ask for a number or email keyboard.</span> <span><b>Zoom text</b>: text boxes under 16 px, which makes iPhones zoom in when tapped.</span> <span><b>Sticky bar</b>: the most screen a fixed button bar covers.</span></div></div>
    ${list('Boxes without a number or email keyboard', 'noHint', 'Add the matching input type or inputmode (numeric for ID, phone, postcode and account; email for email).')}
    ${list('Boxes under 16 px text', 'smallText', 'Use at least 16 px so iPhones do not zoom in when the box is tapped.')}
    ${list('Personal boxes that block autofill', 'noAuto', 'Add the matching autocomplete value so the phone can fill name, email, phone and address.')}
    ${list('Small tap targets', 'smallNames', 'Under 24 px high or wide. Aim for 44 px where there is room.')}` : `<div class="empty">No phone-size run yet. In a terminal run <code>npm run test:mobile</code>, then refresh.</div>`);
  document.querySelectorAll('[data-iv]').forEach((b) => (b.onclick = () => { S.insightView = b.dataset.iv; renderInsights(); scrollTo({ top: 0 }); }));
  document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openProduct(b.dataset.open)));
}

function renderDesignRecs(seg) {
  const tag = { High: 'fail', Medium: 'warn' };
  const cards = DESIGN_RECS.map((r) => `<article class="panel" style="margin-top:8px"><h2><span class="pill ${tag[r.pri]}">${r.pri}</span>${esc(r.title)}</h2>
    <div class="panel-pad" style="display:grid;gap:8px;padding-top:8px">
      <div><b>Our funnel.</b> ${esc(r.ours)}</div>
      <div><b>Others and guidance.</b> ${esc(r.bench)}</div>
      <div><b>Recommendation.</b> ${esc(r.do)}</div>
      <div class="mute"><b>Security and governance.</b> ${esc(r.guard)}</div>
      <div class="mute" style="font-size:14px">Sources: ${r.src.map((k) => `<a href="${SRC[k][1]}" target="_blank" rel="noopener">${esc(SRC[k][0])}</a>`).join(' · ')}</div></div></article>`).join('');
  $('#main').innerHTML = seg + `
    <div class="strip pass"><div><h2>Making it quicker and easier to buy</h2>
      <div class="why">${DESIGN_RECS.length} recommendations for the sales funnels, compared with public information from other Malaysian insurers and general insurance UX guidance.</div></div></div>
    <div class="panel"><h2>How to read this</h2><div class="panel-pad"><ul style="margin:0;padding-left:16px;display:grid;gap:4px">
      <li>"Our funnel" comes from the test screenshots and logs of 2 Oct 2026.</li>
      <li>The other insurers' funnels were not walked through. What is quoted is what their public pages say. Their real purchase screens may differ.</li>
      <li>Some sources are vendor blogs. Where a figure is a vendor claim, it says so.</li>
      <li>Before changing a field or a wording, product, compliance and data protection owners need to approve it.</li></ul></div></div>
    ${cards}
    <div class="panel" style="margin-top:16px"><h2>Suggested measures once changes ship</h2><div class="panel-pad"><ul style="margin:0;padding-left:16px;display:grid;gap:4px">
      <li>Entries before the Summary page (now 8 to 32 depending on the product).</li>
      <li>Time to the Summary page, and the longest wait after pressing Continue.</li>
      <li>Share of customers who reach each step and who finish. This needs your analytics numbers, which these tests cannot see.</li>
      <li>Validation errors per field, to find the questions people get wrong.</li></ul></div></div>`;
  document.querySelectorAll('[data-iv]').forEach((b) => (b.onclick = () => { S.insightView = b.dataset.iv; renderInsights(); scrollTo({ top: 0 }); }));
}

// ---------- screenshot viewer: opens inside the page (a new browser tab is blocked on the shared link) ----------
document.addEventListener('click', (e) => {
  const a = e.target.closest('.shots a, .trio a');
  if (!a) return;
  e.preventDefault();
  const group = [...a.closest('.shots, .trio').querySelectorAll('a')];
  openShot(group, group.indexOf(a));
});
function openShot(group, i) {
  let box = document.getElementById('lightbox');
  if (!box) {
    box = document.createElement('div'); box.id = 'lightbox'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Screenshot');
    document.body.appendChild(box);
    document.addEventListener('keydown', (ev) => {
      if (!document.getElementById('lightbox')?.classList.contains('open')) return;
      if (ev.key === 'Escape') closeShot();
      if (ev.key === 'ArrowRight') stepShot(1);
      if (ev.key === 'ArrowLeft') stepShot(-1);
    });
  }
  box._g = group; box._i = i;
  paintShot();
}
function paintShot() {
  const box = document.getElementById('lightbox'); const a = box._g[box._i];
  const src = a.getAttribute('href');
  box.innerHTML = `<div class="lb-bar"><span>${esc(src.split('/').pop())} (${box._i + 1} of ${box._g.length})</span><span><button class="x" id="lb-prev" ${box._g.length < 2 ? 'hidden' : ''} aria-label="Previous">‹</button> <button class="x" id="lb-next" ${box._g.length < 2 ? 'hidden' : ''} aria-label="Next">›</button> <button class="x" id="lb-close">Close</button></span></div><div class="lb-img"><img src="${esc(src)}" alt="${esc(src.split('/').pop())}"></div>`;
  box.classList.add('open');
  $('#lb-close').onclick = closeShot; $('#lb-prev').onclick = () => stepShot(-1); $('#lb-next').onclick = () => stepShot(1);
  $('#lb-close').focus();
}
function stepShot(d) { const box = document.getElementById('lightbox'); box._i = (box._i + d + box._g.length) % box._g.length; paintShot(); }
function closeShot() { const box = document.getElementById('lightbox'); if (box) { box.classList.remove('open'); box.innerHTML = ''; } }


// ---------- marketing: genuine traffic (GA4) and campaigns (Windsor.ai), pulled by scripts/marketing.mjs ----------
const STAGES = [['funnel_start', 'Started'], ['plan_select', 'Plan chosen'], ['summary_view', 'Summary viewed'], ['pay_click', 'Pay clicked']];
const sum = (a, f) => a.reduce((t, x) => t + (f ? f(x) : x), 0);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const fmtN = (n) => Math.round(n).toLocaleString();
const fmtPct = (v) => (v == null ? '–' : v + '%');
/** last 7 days of data vs the 7 before; dates are ISO strings so they compare as text */
function windows(rows, last) {
  const cut = (n) => { const d = new Date(last + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const a = cut(6), b = cut(13);
  return { cur: rows.filter((r) => r.date >= a), prev: rows.filter((r) => r.date >= b && r.date < a) };
}
const change = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 100) : null);
const chg = (c, goodUp = true) => (c == null ? '' : `<span class="${(c >= 0) === goodUp ? '' : 'stale'}" style="font-size:14px">${c >= 0 ? '+' : ''}${c}% vs previous 7 days</span>`);
const sourceHelp = {
  ga4: ['Google Analytics 4', ['In GA4 Admin > Property details, copy the numeric Property ID into marketing.config.json (ga4.propertyId).', 'Create a service account in Google Cloud, enable the "Google Analytics Data API", and download its JSON key.', 'In GA4 Admin > Property access management, add the service account email as Viewer.', 'Put GA4_CREDENTIALS_FILE=/full/path/key.json in .env.local, then press Refresh data.']],
  windsor: ['Windsor.ai', ['In Windsor.ai, link your data sources (Google Ads, Meta, TikTok and so on) under Data sources.', 'Copy the API key from Windsor.ai settings.', 'Put WINDSOR_API_KEY=... in .env.local, then press Refresh data.']],
};

function marketingChecks(m) {
  const out = [], c = m.checks ?? { dropPct: 40, staleDays: 2 };
  const days = (iso) => Math.floor((Date.now() - Date.parse(iso + 'T23:59:59Z')) / 86400000);
  if (m.ga4?.status === 'ok') {
    const last = m.ga4.daily.map((d) => d.date).sort().at(-1);
    if (!last) out.push({ lvl: 'warn', msg: 'GA4 returned no sessions for this period.' });
    else {
      if (days(last) > c.staleDays) out.push({ lvl: 'fail', msg: `GA4 data stops at ${last}, ${days(last)} days ago. Check the tag and the property.` });
      const w = windows(m.ga4.daily, last), cur = sum(w.cur, (r) => r.sessions), prev = sum(w.prev, (r) => r.sessions), ch = change(cur, prev);
      if (ch != null && ch <= -c.dropPct) out.push({ lvl: 'fail', msg: `Sessions are down ${-ch}% on the previous 7 days.` });
    }
    const ev = m.ga4.events ?? [];
    if (!ev.length) out.push({ lvl: 'warn', msg: 'No funnel events received yet. The sales site still needs to send them.' });
    else for (const p of D.products) {
      const rows = ev.filter((e) => e.product === p.id), latest = rows.map((r) => r.date).sort().at(-1);
      if (!latest) continue;
      const w = windows(rows.filter((r) => r.event === 'summary_view'), latest), cur = sum(w.cur, (r) => r.count), prev = sum(w.prev, (r) => r.count), ch = change(cur, prev);
      if (ch != null && ch <= -c.dropPct) {
        const syn = latestBySuite(p).some((r) => r.health === 'fail');
        out.push({ lvl: 'fail', msg: `${p.name}: customers reaching Summary are down ${-ch}% on the previous 7 days.${syn ? ' The synthetic test is also failing, so this is likely a real outage.' : ' The synthetic test passes, so look at campaigns, traffic mix or tracking.'}`, product: p.id });
      }
    }
  }
  if (m.windsor?.status === 'ok' && m.windsor.daily.length) {
    const last = m.windsor.daily.map((d) => d.date).sort().at(-1);
    if (days(last) > c.staleDays) out.push({ lvl: 'fail', msg: `Windsor.ai data stops at ${last}. A connector may need re-authorising.` });
    const w = windows(m.windsor.daily, last), cur = sum(w.cur, (r) => r.spend), prev = sum(w.prev, (r) => r.spend), ch = change(cur, prev);
    if (ch != null && Math.abs(ch) >= 50) out.push({ lvl: 'warn', msg: `Ad spend moved ${ch > 0 ? '+' : ''}${ch}% on the previous 7 days. Confirm that is intended.` });
  }
  return out;
}

function bars(rows, key, last) {
  const days = [...new Set(rows.map((r) => r.date))].sort();
  const by = days.map((d) => sum(rows.filter((r) => r.date === d), (r) => r[key]));
  const max = Math.max(1, ...by), w = 100 / Math.max(1, days.length);
  return `<svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label="${esc(key)} per day, ${days[0]} to ${days.at(-1)}" style="width:100%;height:70px">${by.map((v, i) => `<rect x="${(i * w + w * 0.12).toFixed(2)}" y="${(30 - (v / max) * 29).toFixed(2)}" width="${(w * 0.76).toFixed(2)}" height="${((v / max) * 29).toFixed(2)}" fill="var(--accent)" rx=".6"><title>${days[i]}: ${fmtN(v)}</title></rect>`).join('')}</svg>`;
}

function renderMarketing() {
  const m = D.marketing ?? {};
  const canRefresh = S.live;
  const refresh = canRefresh ? `<button class="btn primary" id="mkrefresh">Refresh data</button> <button class="btn" id="mksample" title="Fills the tab with made-up numbers so you can review the layout. Never shared.">Preview with sample data</button>` : '<span class="mute">Refresh runs from the local dashboard (npm run serve).</span>';
  const head = `<div class="strip pass"><div><h2>Marketing and genuine traffic</h2><div class="why">Real customer numbers from GA4 and campaign numbers from Windsor.ai, next to what the tests see.${m.generatedAt ? ' Data pulled ' + esc(fmtT(m.generatedAt)) + '.' : ''}</div></div><div>${refresh}</div></div>`;
  const bind = () => {
    const go = async (sample) => {
      const b = $(sample ? '#mksample' : '#mkrefresh'); b.disabled = true; b.textContent = 'Working…';
      try {
        const r = await fetch('/api/marketing/refresh' + (sample ? '?sample=1' : ''), { method: 'POST' });
        const j = await r.json();
        D = await (await fetch('data.json', { cache: 'no-store' })).json();
        toast(r.ok ? 'Marketing data updated' : 'Refresh failed: ' + (j.error ?? ''));
      } catch { toast('Refresh failed. Is the local dashboard server running?'); }
      render();
    };
    $('#mkrefresh') && ($('#mkrefresh').onclick = () => go(false));
    $('#mksample') && ($('#mksample').onclick = () => go(true));
  };
  if (m.hidden) {
    $('#main').innerHTML = head.replace(/<div>[^]*?<\/div><\/div>$/, '</div>') + `<div class="empty">Marketing numbers are not included in the shared page, because they contain traffic and ad spend. Open the local dashboard (http://127.0.0.1:4317, Marketing tab), or ask the owner to set <code>shareMarketing</code> in <code>marketing.config.json</code> once marketing agrees.</div>`;
    return;
  }
  const card = (id) => {
    const st = m[id] ?? { status: 'not-configured', message: 'No data pulled yet.' };
    const [name, steps] = sourceHelp[id];
    const pill = st.status === 'ok' ? '<span class="pill pass">Connected</span>' : st.status === 'error' ? '<span class="pill fail">Error</span>' : '<span class="pill custom">Not connected</span>';
    return `<article class="panel" style="margin-top:8px"><h2>${name} ${pill}${m.sample ? ' <span class="pill warn">Sample data</span>' : ''}</h2><div class="panel-pad" style="padding-top:6px">
      <div>${esc(st.message)}</div>${st.status === 'ok' ? '' : `<ol style="margin:8px 0 0;padding-left:24px;display:grid;gap:3px" class="mute">${steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`}</div></article>`;
  };
  const g = m.ga4?.status === 'ok' ? m.ga4 : null, w = m.windsor?.status === 'ok' ? m.windsor : null;
  let body = '';
  if (m.sample) body += `<div class="strip" style="margin-top:8px;border-left-color:var(--strong)"><div><h2 style="font-size:16px">Sample data</h2><div class="why">These numbers are made up, only to review the layout. Press Refresh data once GA4 and Windsor.ai are connected to replace them.</div></div></div>`;
  const checks = marketingChecks(m);
  body += `<div class="panel"><h2>Checks <span class="chip">${checks.length ? checks.length + ' to look at' : 'nothing flagged'}</span></h2><div class="panel-pad" style="padding-top:6px">${
    checks.length ? checks.map((c) => `<div style="display:flex;gap:8px;align-items:baseline;padding:4px 0"><span class="pill ${c.lvl}">${c.lvl === 'fail' ? 'Act' : 'Look'}</span><span>${esc(c.msg)}</span>${c.product ? `<button class="btn" data-open="${c.product}" style="margin-left:auto">Test results ›</button>` : ''}</div>`).join('')
      : (g || w) ? '<span class="mute">Data is fresh and no sharp drops were found.</span>' : '<span class="mute">Connect a source to start these checks: data freshness, sudden drops in sessions or in customers reaching Summary, ad spend jumps, and whether a drop matches a failing test.</span>'}</div></div>`;
  if (g) {
    const last = g.daily.map((d) => d.date).sort().at(-1);
    const wd = windows(g.daily, last), ses = [sum(wd.cur, (r) => r.sessions), sum(wd.prev, (r) => r.sessions)];
    const mob = pct(sum(wd.cur.filter((r) => r.device === 'mobile'), (r) => r.sessions), ses[0]);
    const ev = g.events ?? [], we = windows(ev, last);
    const cnt = (rows, e) => sum(rows.filter((r) => r.event === e), (r) => r.count);
    const st = [cnt(we.cur, 'funnel_start'), cnt(we.prev, 'funnel_start')], sv = [cnt(we.cur, 'summary_view'), cnt(we.prev, 'summary_view')];
    const tile = (t, v, sub) => `<div class="panel" style="margin:0;padding:16px 16px"><div class="mute" style="font-size:14px">${t}</div><div style="font-size:20px;font-weight:650;letter-spacing:-.01em">${v}</div><div>${sub}</div></div>`;
    body += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px;margin-top:24px">
      ${tile('Sessions, last 7 days', fmtN(ses[0]), chg(change(...ses)))}
      ${tile('Share on phones', fmtPct(mob), '<span class="mute" style="font-size:14px">of sessions</span>')}
      ${tile('Quotes started', st[0] ? fmtN(st[0]) : '–', chg(change(...st)))}
      ${tile('Start to Summary', fmtPct(pct(sv[0], st[0])), `<span class="mute" style="font-size:14px">previous ${fmtPct(pct(sv[1], st[1]))}</span>`)}</div>
      <div class="panel"><h2>Sessions per day <span class="chip">${esc(m.range.from)} to ${esc(m.range.to)}</span></h2><div class="panel-pad">${bars(g.daily, 'sessions', last)}</div></div>`;
    const prods = D.products.map((p) => ({ p, rows: we.cur.filter((r) => r.product === p.id) })).filter((x) => x.rows.length);
    const cols = '--cols:minmax(150px,1.4fr) repeat(4,minmax(70px,1fr)) 80px 90px';
    body += `<div class="panel"><h2>Funnel by product <span class="chip">last 7 days</span></h2><div class="sub2">Genuine customers only. Drop-off is measured from Started. Click a row to see what the tests say for the same product.</div>
      <div class="gt" style="${cols}"><div class="gt-head"><span>Product</span>${STAGES.map(([, l]) => `<span class="r">${l}</span>`).join('')}<span class="r">Drop-off</span><span>Test</span></div>${
        prods.length ? prods.map(({ p, rows }) => {
          const c = STAGES.map(([e]) => cnt(rows, e)), tst = latestBySuite(p).map((r) => r.health);
          return `<button class="gt-row" data-open="${p.id}"><span class="name">${esc(p.name)}</span>${c.map((n) => `<span class="num">${n ? fmtN(n) : '–'}</span>`).join('')}<span class="num">${c[0] ? fmtPct(Math.round((1 - c[2] / c[0]) * 1000) / 10) : '–'}</span><span class="pill ${tst.includes('fail') ? 'fail' : tst.includes('warn') ? 'warn' : tst.length ? 'pass' : 'custom'}">${tst.includes('fail') ? 'Failing' : tst.includes('warn') ? 'Warnings' : tst.length ? 'Passing' : 'None'}</span></button>`;
        }).join('') : '<div class="empty" style="padding:24px">No funnel events by product yet. See the event list for the web team in the README (Marketing tab section).</div>'}</div></div>`;
    body += `<div class="panel"><h2>Where sessions come from <span class="chip">GA4, ${esc(String(m.range.from))} to ${esc(String(m.range.to))}</span></h2><div class="gt" style="--cols:minmax(180px,2fr) 100px 100px"><div class="gt-head"><span>Source / medium</span><span class="r">Sessions</span><span class="r">Engaged</span></div>${g.sources.map((x) => `<div class="gt-row" style="cursor:default"><span class="name">${esc(x.source)}</span><span class="num">${fmtN(x.sessions)}</span><span class="num">${fmtPct(pct(x.engaged, x.sessions))}</span></div>`).join('')}</div></div>`;
  }
  if (w) {
    const last = w.daily.map((d) => d.date).sort().at(-1), wd = windows(w.daily, last);
    const spend = [sum(wd.cur, (r) => r.spend), sum(wd.prev, (r) => r.spend)], clicks = [sum(wd.cur, (r) => r.clicks), sum(wd.prev, (r) => r.clicks)];
    body += `<div class="panel"><h2>Campaigns <span class="chip">Windsor.ai</span></h2><div class="sub2">Spend ${fmtN(spend[0])} ${chg(change(...spend), false)} · Clicks ${fmtN(clicks[0])} ${chg(change(...clicks))} (last 7 days). Table below covers the whole period.</div>
      <div class="panel-pad" style="padding-top:0">${bars(w.daily, 'spend', last)}</div>
      <div class="gt" style="--cols:minmax(100px,1fr) minmax(150px,2fr) 90px 90px 80px"><div class="gt-head"><span>Platform</span><span>Campaign</span><span class="r">Spend</span><span class="r">Clicks</span><span class="r">Cost/click</span></div>${w.campaigns.map((c) => `<div class="gt-row" style="cursor:default"><span>${esc(c.source)}</span><span class="name">${esc(c.campaign)}</span><span class="num">${fmtN(c.spend)}</span><span class="num">${fmtN(c.clicks)}</span><span class="num">${c.clicks ? (c.spend / c.clicks).toFixed(2) : '–'}</span></div>`).join('')}</div></div>`;
  }
  $('#main').innerHTML = head + `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:8px">${card('ga4')}${card('windsor')}</div>` + body +
    `<div class="panel"><h2>Privacy</h2><div class="panel-pad" style="padding-top:6px">Only daily totals are shown. No NRIC, passport, name or contact detail is pulled or stored. Keys stay in <code>.env.local</code> on the machine that refreshes the data, and this tab is left out of the shared page.</div></div>`;
  bind();
  document.querySelectorAll('[data-open]').forEach((b) => (b.onclick = () => openProduct(b.dataset.open)));
}

// ---------- deep links: #monitor-car, #insights, #compare, #run (plain tokens, so they survive the shared viewer) ----------
function syncHash() {
  const h = S.view === 'monitor' ? (S.selected ? 'monitor-' + S.selected : 'monitor') : S.view;
  try { if (location.hash.slice(1) !== h) history.replaceState(null, '', '#' + h); } catch { /* not allowed here */ }
}
function readHash() {
  const [v, ...rest] = location.hash.slice(1).split('-');
  if (!['monitor', 'insights', 'marketing', 'compare', 'run'].includes(v)) return;
  S.view = v;
  const id = rest.join('-');
  if (v === 'monitor' && id && D.products.some((p) => p.id === id)) S.selected = id;
}
window.addEventListener('hashchange', () => { readHash(); render(); });

// ---------- boot ----------
readHash();
render();
probe().then(render);
