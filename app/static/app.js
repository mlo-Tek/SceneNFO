const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const content = $('#content');

let currentView = 'dashboard';
let activeJobs = new Map();
let liveRows = [];
let dashboardPreset = null;

const api = async (url, opts={}) => {
  const r = await fetch(url, {
    headers: {'Content-Type':'application/json', ...(opts.headers||{})},
    ...opts,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.status === 204 ? null : r.json();
};

const esc = v => String(v ?? '').replace(/[&<>'"]/g, c => ({
  '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
}[c]));

const toast = (msg, tone='default') => {
  const t = $('#toast');
  t.textContent = msg;
  t.dataset.tone = tone;
  t.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
};

const pill = c => `<span class="pill ${esc(c)}">${c==='scene'?'SCENE':c==='p2p'?'P2P':esc(c)}</span>`;
const policyLabel = p => p === 'replace_all' ? 'Replace all Scene NFOs' : 'Only add missing NFOs';
const modeLabel = apply => apply ? 'Apply' : 'Dry Run';

function initialTheme(){
  const saved = localStorage.getItem('scenenfo-theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme){
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('scenenfo-theme', theme);
  const btn = $('#theme-toggle');
  if (btn){
    btn.textContent = theme === 'dark' ? '☀︎' : '☾';
    btn.title = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
    btn.setAttribute('aria-label', btn.title);
  }
  $$('.theme-choice').forEach(b => b.classList.toggle('active', b.dataset.theme === theme));
}

function toggleTheme(){
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
}

const titles = {
  dashboard:['Dashboard','Media overview and quick run'],
  movies:['Movies','Movie library inventory'],
  tv:['TV Shows','TV episode inventory'],
  'groups-scene':['Scene Groups','Synced from PreDB.club'],
  'groups-p2p':['P2P Groups','Curated P2P release groups'],
  scan:['Scan','Run one or multiple configured libraries'],
  history:['History','Manual, scheduled and import runs'],
  logs:['Logs','Application activity'],
  settings:['Settings','Libraries, schedules, sources and appearance'],
};

async function navigate(view){
  currentView = view;
  $$('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#page-title').textContent = titles[view][0];
  $('#page-subtitle').textContent = titles[view][1];

  if (view === 'dashboard') return renderDashboard();
  if (view === 'movies') return renderLibrary('movies');
  if (view === 'tv') return renderLibrary('tv');
  if (view === 'groups-scene') return renderGroups('scene');
  if (view === 'groups-p2p') return renderGroups('p2p');
  if (view === 'scan') return renderScan();
  if (view === 'history') return renderHistory();
  if (view === 'logs') return renderLogs();
  if (view === 'settings') return renderSettings();
}

function libraryChecks(libs, selected=[], cls='run-lib'){
  const selectedSet = new Set(selected.map(Number));
  return `<div class="library-check-grid">${libs.map(l => `
    <label class="library-check ${selectedSet.has(Number(l.id))?'selected':''}">
      <input type="checkbox" class="${cls}" value="${l.id}" ${selectedSet.has(Number(l.id))?'checked':''}>
      <span><strong>${esc(l.name)}</strong><small>${esc(l.path)}</small></span>
      <span class="kind-chip">${l.kind === 'movies' ? 'MOVIE' : 'TV'}</span>
    </label>`).join('')}</div>`;
}

function bindCheckCardSelection(root=document){
  $$('label.library-check input[type=checkbox]', root).forEach(cb => {
    cb.addEventListener('change', () => cb.closest('.library-check')?.classList.toggle('selected', cb.checked));
  });
}

async function renderDashboard(){
  const [d, libs] = await Promise.all([api('/api/dashboard'), api('/api/libraries')]);
  const enabled = libs.filter(l => l.enabled);
  const allIds = enabled.map(l => Number(l.id));

  content.innerHTML = `
    <div class="stats-grid">
      <div class="card stat accent-blue"><div class="stat-label">Movies</div><div class="stat-value">${d.movies}</div></div>
      <div class="card stat accent-purple"><div class="stat-label">TV Episodes</div><div class="stat-value">${d.tv}</div></div>
      <div class="card stat accent-cyan"><div class="stat-label">Libraries</div><div class="stat-value">${d.libraries}</div></div>
      <div class="card stat accent-green"><div class="stat-label">Scene</div><div class="stat-value">${d.scene}</div></div>
      <div class="card stat accent-orange"><div class="stat-label">P2P</div><div class="stat-value">${d.p2p}</div></div>
      <div class="card stat accent-teal"><div class="stat-label">NFO Present</div><div class="stat-value">${d.nfo}</div></div>
    </div>

    <div class="card section-card dashboard-run-card">
      <div class="section-head">
        <div>
          <h2>Quick run</h2>
          <p>Same scan engine as Operations → Scan, with the important options directly on the dashboard.</p>
        </div>
        <span class="pill info">QUICK</span>
      </div>

      <div class="quick-run-grid">
        <div class="quick-run-main">
          <div class="field-label">Libraries</div>
          ${libraryChecks(enabled, allIds, 'dash-lib')}
        </div>
        <div class="quick-run-options">
          <label class="stack-field"><span>Mode</span><select id="dash-mode"><option value="false">Dry Run</option><option value="true">Apply changes</option></select></label>
          <label class="stack-field"><span>NFO handling</span><select id="dash-policy"><option value="missing_only">Only add missing NFOs</option><option value="replace_all">Replace all Scene NFOs</option></select></label>
          <button class="btn primary wide" id="dash-run" ${enabled.length?'':'disabled'}>Start Dry Run</button>
          <div class="run-hint" id="dash-run-hint">Dry Run only analyzes and previews changes.</div>
        </div>
      </div>
    </div>

    <div class="dashboard-two-col">
      <div class="card section-card compact-card accent-green-border">
        <h3>Classification</h3>
        <p>Exact PreDB.club release match = <strong>Scene</strong>. Everything else is shown as <strong>P2P</strong>.</p>
        <div class="metric-row"><span>Scene share</span><strong>${d.scene+d.p2p?Math.round(d.scene/(d.scene+d.p2p)*100):0}%</strong></div>
      </div>
      <div class="card section-card compact-card accent-cyan-border">
        <h3>NFO coverage</h3>
        <p>Coverage is calculated from the items already inventoried by SceneNFO.</p>
        <div class="metric-row"><span>Coverage</span><strong>${d.movies+d.tv?Math.round(d.nfo/(d.movies+d.tv)*100):0}%</strong></div>
      </div>
    </div>`;

  bindCheckCardSelection(content);
  const syncDashMode = () => {
    const apply = $('#dash-mode').value === 'true';
    $('#dash-run').textContent = apply ? 'Start Apply Run' : 'Start Dry Run';
    $('#dash-run').classList.toggle('warning', apply);
    $('#dash-run').classList.toggle('primary', !apply);
    $('#dash-run-hint').textContent = apply
      ? 'Apply can create or replace verified Scene NFO files.'
      : 'Dry Run only analyzes and previews changes.';
  };
  $('#dash-mode').onchange = syncDashMode;
  syncDashMode();

  if (enabled.length) $('#dash-run').onclick = async () => {
    const libraryIds = $$('.dash-lib:checked').map(x => Number(x.value));
    if (!libraryIds.length) return toast('Select at least one library', 'warning');
    dashboardPreset = {
      libraryIds,
      apply: $('#dash-mode').value === 'true',
      nfoPolicy: $('#dash-policy').value,
      autoStart: true,
    };
    await navigate('scan');
  };
}

async function renderLibrary(kind){
  const libs = await api(`/api/libraries?kind=${kind}`);
  content.innerHTML = `<div class="card section-card">
    <div class="section-head"><div><h2>${kind==='movies'?'Movies':'TV Shows'}</h2><p>Filter by configured library, release type, group and NFO state.</p></div></div>
    <div class="toolbar library-toolbar">
      <select id="lib-config"><option value="">All ${kind==='movies'?'movie':'TV'} libraries</option>${libs.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
      <input id="lib-q" class="field grow" placeholder="Search title, release or group…">
      <select id="lib-class"><option value="">All types</option><option value="scene">Scene</option><option value="p2p">P2P</option></select>
      <select id="lib-nfo"><option value="">All NFO</option><option value="present">NFO present</option><option value="missing">NFO missing</option></select>
      <button class="btn secondary" id="lib-filter">Apply filters</button>
    </div>
    <div id="lib-table" class="table-space"></div>
  </div>`;

  const load = async () => {
    const q=encodeURIComponent($('#lib-q').value), c=$('#lib-class').value, n=$('#lib-nfo').value, lid=$('#lib-config').value;
    const rows = await api(`/api/library/${kind}?q=${q}&classification=${c}&nfo=${n}&library_id=${lid}&limit=2000`);
    $('#lib-table').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Library</th><th>Title</th><th>Type</th><th>Group</th><th>NFO</th><th>Source</th><th>Result</th><th>Release</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.configured_library||'Legacy')}</td><td>${esc(r.title)}</td><td>${pill(r.classification)}</td><td>${esc(r.release_group||'Unknown')}</td><td>${r.nfo_present?'✓ Present':'— Missing'}</td><td>${esc(r.nfo_source||'Local / Unknown')}</td><td>${esc(r.last_result||'')}</td><td class="mono">${esc(r.release_name)}</td></tr>`).join('')}</tbody></table></div>`;
  };
  $('#lib-filter').onclick = load;
  $('#lib-q').addEventListener('keydown', e => { if(e.key==='Enter') load(); });
  await load();
}

async function renderGroups(classification){
  content.innerHTML = `<div class="card section-card"><div class="section-head"><div><h2>${classification==='scene'?'Scene Groups':'P2P Groups'}</h2><p>${classification==='scene'?'Synced from PreDB.club.':'Curated P2P release groups.'}</p></div>${classification==='scene'?'<button class="btn secondary" id="sync-groups">Sync now</button>':'<button class="btn secondary" id="reseed-groups">Reload curated list</button>'}</div><div class="toolbar"><input id="group-q" class="field grow" placeholder="Search group or origin…"><button class="btn secondary" id="group-filter">Search</button></div><div id="groups-table" class="table-space"></div></div>`;
  const load = async () => {
    const q=encodeURIComponent($('#group-q').value); const rows=await api(`/api/groups?classification=${classification}&q=${q}`);
    $('#groups-table').innerHTML=`<div class="table-wrap"><table><thead><tr><th>Group</th><th>Class</th><th>Active</th><th>Origin</th><th>Type</th><th>Aliases</th><th>Source</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong></td><td>${pill(r.classification)}</td><td>${esc(r.active||'—')}</td><td>${esc(r.origin||'—')}</td><td>${esc(r.distribution_type||'—')}</td><td>${esc(r.aliases||'—')}</td><td>${esc(r.source)}</td></tr>`).join('')}</tbody></table></div>`;
  };
  $('#group-filter').onclick=load;
  $('#group-q').addEventListener('keydown', e=>{if(e.key==='Enter')load()});
  if ($('#sync-groups')) $('#sync-groups').onclick=async()=>{const x=await api('/api/groups/sync-scene',{method:'POST'});toast(`Synced ${x.synced} Scene groups`);load();};
  if ($('#reseed-groups')) $('#reseed-groups').onclick=async()=>{const x=await api('/api/groups/reseed-p2p',{method:'POST'});toast(`Loaded ${x.seeded} P2P groups`);load();};
  await load();
}

async function renderScan(){
  const libs=(await api('/api/libraries')).filter(l=>l.enabled);
  const preset = dashboardPreset;
  dashboardPreset = null;
  const selected = preset?.libraryIds?.length ? preset.libraryIds : libs.map(l=>Number(l.id));
  const apply = preset?.apply ?? false;
  const nfoPolicy = preset?.nfoPolicy ?? 'missing_only';

  content.innerHTML = `<div class="scan-layout">
    <div class="card section-card scan-controls">
      <div class="section-head"><div><h2>Run configuration</h2><p>Select one or multiple libraries.</p></div><span class="pill info">MULTI</span></div>
      <div class="field-label">Libraries</div>
      ${libraryChecks(libs, selected, 'scan-lib')}
      <div class="scan-options-grid">
        <label class="stack-field"><span>Mode</span><select id="scan-mode"><option value="false" ${apply?'':'selected'}>Dry Run</option><option value="true" ${apply?'selected':''}>Apply changes</option></select></label>
        <label class="stack-field"><span>NFO handling</span><select id="scan-policy"><option value="missing_only" ${nfoPolicy==='missing_only'?'selected':''}>Only add missing NFOs</option><option value="replace_all" ${nfoPolicy==='replace_all'?'selected':''}>Replace all Scene NFOs</option></select></label>
      </div>
      <div class="scan-actions"><button class="btn primary" id="run-scan" ${libs.length?'':'disabled'}>Start Dry Run</button><button class="btn danger" id="stop-scan" ${activeJobs.size?'':'disabled'}>Stop all</button></div>
      <div class="run-hint" id="scan-run-hint"></div>
      <div class="scan-progress-block"><div class="scan-status-row"><span id="scan-status">${libs.length?'Ready':'No enabled libraries configured'}</span><span id="scan-progress-text"></span></div><div class="progress-shell"><div class="progress" id="scan-progress"></div></div><div id="scan-counts" class="scan-counts"></div></div>
    </div>

    <div class="card section-card live-results-card">
      <div class="section-head"><div><h2>Live results</h2><p>Results from all selected libraries are merged here.</p></div><span id="active-job-count" class="pill info">${activeJobs.size} ACTIVE</span></div>
      <div class="live-list" id="live-list"></div>
    </div>
  </div>`;

  bindCheckCardSelection(content);
  const syncScanMode = () => {
    const isApply = $('#scan-mode').value === 'true';
    $('#run-scan').textContent = isApply ? 'Start Apply Run' : 'Start Dry Run';
    $('#run-scan').classList.toggle('warning', isApply);
    $('#run-scan').classList.toggle('primary', !isApply);
    $('#scan-run-hint').textContent = isApply
      ? 'Apply writes verified Scene NFO changes. P2P releases are not modified.'
      : 'Dry Run does not write or delete any files.';
  };
  $('#scan-mode').onchange = syncScanMode;
  syncScanMode();
  if (libs.length) $('#run-scan').onclick = () => startSelectedLibraries();
  $('#stop-scan').onclick = stopAllScans;

  if (preset?.autoStart) setTimeout(() => startSelectedLibraries(), 0);
}

async function startSelectedLibraries(){
  if (activeJobs.size) return toast('A scan is already running', 'warning');
  const libraryIds = $$('.scan-lib:checked').map(x=>Number(x.value));
  if (!libraryIds.length) return toast('Select at least one library', 'warning');
  return startMultiLibraryScan({
    libraryIds,
    apply: $('#scan-mode').value === 'true',
    nfoPolicy: $('#scan-policy').value,
  });
}

function updateMultiProgress(){
  if (!$('#scan-progress')) return;
  const jobs=[...activeJobs.values()];
  const knownTotals=jobs.reduce((a,j)=>a+(j.total||0),0);
  const completedItems=jobs.reduce((a,j)=>a+(j.index||0),0);
  const completedJobs=jobs.filter(j=>j.done).length;
  const pct=knownTotals?Math.min(100,Math.round(completedItems/knownTotals*100)):0;
  $('#scan-progress').style.width=`${pct}%`;
  $('#scan-progress-text').textContent=knownTotals?`${completedItems} / ${knownTotals}`:`${completedJobs} / ${jobs.length} libraries`;
  $('#active-job-count').textContent=`${jobs.filter(j=>!j.done).length} ACTIVE`;
}

function renderLiveRows(){
  const list=$('#live-list');
  if (!list) return;
  list.innerHTML = liveRows.length ? liveRows.map(r=>`<div class="live-row"><span class="live-library">${esc(r.library_name||'')}</span><span>${r.index||''}${r.total?`/${r.total}`:''}</span>${r.classification?pill(r.classification):'<span></span>'}<span class="mono ellipsis">${esc(r.release||r.message||'')}</span><span class="action-chip">${esc(r.action||'')}</span></div>`).join('') : '<div class="empty-state">No scan results yet.</div>';
}

async function startMultiLibraryScan({libraryIds, apply, nfoPolicy}){
  liveRows=[];
  renderLiveRows();
  const libs = await api('/api/libraries');
  const byId = new Map(libs.map(l=>[Number(l.id),l]));
  const summary={scene:0,p2p:0,created:0,replaced:0,errors:0};

  $('#scan-status').textContent=`Starting ${libraryIds.length} ${libraryIds.length===1?'library':'libraries'}…`;
  $('#stop-scan').disabled=false;
  $('#run-scan').disabled=true;
  $('#scan-counts').textContent='';

  for (const libraryId of libraryIds){
    const lib = byId.get(Number(libraryId));
    const x = await api('/api/scans', {method:'POST', body:JSON.stringify({library_id:libraryId,apply,nfo_policy:nfoPolicy})});
    activeJobs.set(x.job_id,{id:x.job_id,name:lib?.name||`Library ${libraryId}`,total:0,index:0,done:false,source:null});
  }

  for (const [jobId, job] of activeJobs){
    const es = new EventSource(`/api/scans/${jobId}/events`);
    job.source=es;
    es.onmessage=e=>{
      const d=JSON.parse(e.data);
      if(d.type==='start') $('#scan-status').textContent=`Running ${activeJobs.size} ${activeJobs.size===1?'library':'libraries'} · ${modeLabel(apply)} · ${policyLabel(nfoPolicy)}`;
      if(d.type==='inventory'){job.total=d.total||0;updateMultiProgress();}
      if(d.type==='item'){
        job.index=d.index||job.index;
        liveRows.unshift({...d,library_name:d.library_name||job.name});
        liveRows=liveRows.slice(0,500);
        renderLiveRows();
        updateMultiProgress();
      }
      if(d.type==='item_error'){
        job.index=d.index||job.index;
        liveRows.unshift({...d,library_name:job.name,action:'ERROR'});
        liveRows=liveRows.slice(0,500);
        renderLiveRows();
        updateMultiProgress();
      }
      if(d.type==='complete'){
        job.done=true;
        job.index=job.total||job.index;
        summary.scene+=d.scene||0; summary.p2p+=d.p2p||0; summary.created+=d.created||0; summary.replaced+=d.replaced||0; summary.errors+=d.errors||0;
        es.close();
        updateMultiProgress();
        finishBatchIfDone(summary, apply, nfoPolicy);
      }
      if(d.type==='fatal'||d.type==='cancelled'){
        job.done=true; es.close(); updateMultiProgress(); finishBatchIfDone(summary, apply, nfoPolicy);
      }
    };
    es.onerror=()=>{
      if(es.readyState===EventSource.CLOSED) return;
      $('#scan-status').textContent=`Live connection interrupted for ${job.name}`;
    };
  }
  updateMultiProgress();
}

function finishBatchIfDone(summary, apply, nfoPolicy){
  const jobs=[...activeJobs.values()];
  if(!jobs.length || jobs.some(j=>!j.done)) return;
  $('#scan-progress').style.width='100%';
  $('#scan-status').textContent=`Completed ${jobs.length} ${jobs.length===1?'library':'libraries'} · ${modeLabel(apply)}`;
  $('#scan-counts').textContent=`${summary.scene} Scene · ${summary.p2p} P2P · ${summary.created} created · ${summary.replaced} replaced · ${summary.errors} errors · ${policyLabel(nfoPolicy)}`;
  $('#stop-scan').disabled=true;
  $('#run-scan').disabled=false;
  toast('Scan completed','success');
  activeJobs.clear();
  $('#active-job-count').textContent='0 ACTIVE';
}

async function stopAllScans(){
  const ids=[...activeJobs.keys()];
  if(!ids.length) return;
  await Promise.allSettled(ids.map(id=>api(`/api/scans/${id}/stop`,{method:'POST'})));
  toast(`Stop requested for ${ids.length} scan${ids.length===1?'':'s'}`,'warning');
}

async function renderHistory(){
  const rows=await api('/api/history?limit=250');
  content.innerHTML=`<div class="card section-card"><div class="section-head"><div><h2>Runs</h2><p>Manual, scheduled and import-triggered activity.</p></div></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Started</th><th>Library</th><th>Trigger</th><th>Mode</th><th>NFO handling</th><th>Status</th><th>Scanned</th><th>Scene</th><th>P2P</th><th>Created</th><th>Replaced</th><th>Errors</th></tr></thead><tbody>${rows.map(r=>`<tr><td>#${r.id}</td><td>${esc(r.started_at)}</td><td>${esc(r.library_name||r.library||'')}</td><td>${esc(r.trigger)}</td><td>${esc(r.mode)}</td><td>${esc(r.nfo_policy?policyLabel(r.nfo_policy):'')}</td><td>${esc(r.status)}</td><td>${r.scanned}</td><td>${r.scene}</td><td>${r.p2p}</td><td>${r.created}</td><td>${r.replaced}</td><td>${r.errors}</td></tr>`).join('')}</tbody></table></div></div>`;
}

async function renderLogs(){
  const rows=await api('/api/logs?limit=3000');
  content.innerHTML=`<div class="card section-card"><div class="section-head"><div><h2>Logs</h2><p>Newest events first.</p></div><button class="btn secondary" id="reload-logs">Reload</button></div><div class="logbox">${rows.map(r=>`<div class="logline ${String(r.level).toLowerCase()}">[${esc(r.ts)}] ${esc(r.level)} ${esc(r.library_name||r.library||'')} ${esc(r.event)} — ${esc(r.message)}</div>`).join('')}</div></div>`;
  $('#reload-logs').onclick=renderLogs;
}

function libraryEditor(l){
  return `<div class="editor-row library-editor" data-library-id="${l.id}">
    <div class="editor-main four-cols">
      <label class="stack-field"><span>Name</span><input class="field lib-name" value="${esc(l.name)}"></label>
      <label class="stack-field"><span>Type</span><select class="lib-kind"><option value="movies" ${l.kind==='movies'?'selected':''}>Movies</option><option value="tv" ${l.kind==='tv'?'selected':''}>TV</option></select></label>
      <label class="stack-field span-path"><span>Container path</span><input class="field lib-path mono" value="${esc(l.path)}"></label>
      <label class="toggle-field"><input type="checkbox" class="lib-enabled" ${l.enabled?'checked':''}><span>Enabled</span></label>
    </div>
    <div class="editor-actions"><button class="btn secondary save-library">Save library</button><button class="btn danger delete-library">Delete</button></div>
  </div>`;
}

function scheduleEditor(s, libs){
  return `<div class="editor-row schedule-editor" data-schedule-id="${s.id}">
    <div class="schedule-head-grid">
      <label class="stack-field"><span>Name</span><input class="field sched-name" value="${esc(s.name)}"></label>
      <label class="stack-field"><span>Cron</span><input class="field sched-cron mono" value="${esc(s.cron)}"></label>
      <label class="stack-field"><span>Status</span><select class="sched-enabled"><option value="true" ${s.enabled?'selected':''}>Enabled</option><option value="false" ${s.enabled?'':'selected'}>Disabled</option></select></label>
      <label class="stack-field"><span>Mode</span><select class="sched-apply"><option value="false" ${s.apply_changes?'':'selected'}>Dry Run</option><option value="true" ${s.apply_changes?'selected':''}>Apply</option></select></label>
      <label class="stack-field"><span>NFO handling</span><select class="sched-policy"><option value="missing_only" ${s.nfo_policy==='missing_only'?'selected':''}>Missing only</option><option value="replace_all" ${s.nfo_policy==='replace_all'?'selected':''}>Replace all</option></select></label>
    </div>
    <div class="field-label schedule-libraries-label">Libraries included in this run</div>
    ${libraryChecks(libs, s.library_ids, 'sched-lib')}
    <div class="editor-actions"><button class="btn secondary save-schedule">Save schedule</button><button class="btn danger delete-schedule">Delete</button></div>
  </div>`;
}

function collectSchedule(el){
  return {
    name: $('.sched-name',el).value,
    cron: $('.sched-cron',el).value,
    enabled: $('.sched-enabled',el).value==='true',
    apply_changes: $('.sched-apply',el).value==='true',
    nfo_policy: $('.sched-policy',el).value,
    library_ids: $$('.sched-lib:checked',el).map(x=>Number(x.value)),
  };
}

async function renderSettings(){
  const [libs,schedules,s] = await Promise.all([api('/api/libraries'),api('/api/schedules'),api('/api/settings')]);
  const val=k=>typeof s[k]==='object'?(s[k].value||''):s[k]??'';

  content.innerHTML=`
    <div class="settings-stack">
      <div class="card settings-section accent-blue-border">
        <div class="section-head"><div><h2>Libraries</h2><p>Add, rename, disable or delete libraries. Schedules reference library IDs, so renames propagate automatically.</p></div><span class="pill info">${libs.length} LIBRARIES</span></div>
        <div id="library-list">${libs.map(libraryEditor).join('')}</div>
        <div class="add-panel">
          <h3>Add library</h3>
          <div class="editor-main add-library-grid">
            <label class="stack-field"><span>Name</span><input id="new-lib-name" class="field" placeholder="e.g. Anime"></label>
            <label class="stack-field"><span>Type</span><select id="new-lib-kind"><option value="movies">Movies</option><option value="tv">TV</option></select></label>
            <label class="stack-field"><span>Container path</span><input id="new-lib-path" class="field mono" placeholder="/data/media/..."></label>
            <button class="btn primary align-end" id="add-library">Add library</button>
          </div>
        </div>
      </div>

      <div class="card settings-section accent-purple-border">
        <div class="section-head"><div><h2>Schedules</h2><p>Each schedule has its own libraries, mode and NFO policy.</p></div><span class="pill info">${schedules.length} SCHEDULES</span></div>
        <div id="schedule-list">${schedules.length?schedules.map(sc=>scheduleEditor(sc,libs)).join(''):'<div class="empty-state">No schedules configured.</div>'}</div>
        <div class="add-panel">
          <h3>Add schedule</h3>
          <div class="schedule-head-grid">
            <label class="stack-field"><span>Name</span><input id="new-sched-name" class="field" placeholder="Nightly missing NFOs"></label>
            <label class="stack-field"><span>Cron</span><input id="new-sched-cron" class="field mono" value="0 3 * * *"></label>
            <label class="stack-field"><span>Status</span><select id="new-sched-enabled"><option value="false">Disabled</option><option value="true">Enabled</option></select></label>
            <label class="stack-field"><span>Mode</span><select id="new-sched-apply"><option value="false">Dry Run</option><option value="true">Apply</option></select></label>
            <label class="stack-field"><span>NFO handling</span><select id="new-sched-policy"><option value="missing_only">Missing only</option><option value="replace_all">Replace all</option></select></label>
          </div>
          <div class="field-label schedule-libraries-label">Libraries included in this run</div>
          ${libraryChecks(libs,libs.map(l=>Number(l.id)),'new-sched-lib')}
          <div class="editor-actions"><button class="btn primary" id="add-schedule">Add schedule</button></div>
        </div>
      </div>

      <div class="settings-two-col">
        <div class="card settings-section accent-cyan-border">
          <div class="section-head"><div><h2>Sources</h2><p>NFO source priority and crowdNFO credentials.</p></div></div>
          <label class="stack-field"><span>srrDB</span><input class="field source-setting" data-key="srrdb_base_url" value="${esc(val('srrdb_base_url'))}"></label>
          <label class="stack-field"><span>PreDB.club</span><input class="field source-setting" data-key="predb_base_url" value="${esc(val('predb_base_url'))}"></label>
          <label class="stack-field"><span>crowdNFO</span><input class="field source-setting" data-key="crowdnfo_base_url" value="${esc(val('crowdnfo_base_url'))}"></label>
          <label class="stack-field"><span>crowdNFO API key</span><input type="password" class="field source-setting" data-key="crowdnfo_api_key" value="${esc(val('crowdnfo_api_key'))}" placeholder="API key"></label>
          <label class="stack-field"><span>Priority</span><input class="field source-setting mono" data-key="source_priority" value="${esc(val('source_priority'))}"></label>
          <div class="editor-actions"><button class="btn secondary" id="test-sources">Test connections</button><button class="btn primary" id="save-sources">Save sources</button></div>
        </div>

        <div class="card settings-section accent-orange-border">
          <div class="section-head"><div><h2>Import automation</h2><p>Radarr/Sonarr webhook behavior.</p></div></div>
          <label class="stack-field"><span>Radarr webhook</span><select class="automation-setting" data-key="radarr_webhook_enabled"><option value="true" ${val('radarr_webhook_enabled')==='true'?'selected':''}>Enabled</option><option value="false" ${val('radarr_webhook_enabled')==='false'?'selected':''}>Disabled</option></select></label>
          <label class="stack-field"><span>Sonarr webhook</span><select class="automation-setting" data-key="sonarr_webhook_enabled"><option value="true" ${val('sonarr_webhook_enabled')==='true'?'selected':''}>Enabled</option><option value="false" ${val('sonarr_webhook_enabled')==='false'?'selected':''}>Disabled</option></select></label>
          <label class="stack-field"><span>Import mode</span><select class="automation-setting" data-key="import_apply"><option value="false" ${val('import_apply')==='false'?'selected':''}>Scan only</option><option value="true" ${val('import_apply')==='true'?'selected':''}>Apply</option></select></label>
          <label class="stack-field"><span>NFO handling</span><select class="automation-setting" data-key="import_nfo_policy"><option value="missing_only" ${val('import_nfo_policy')==='missing_only'?'selected':''}>Missing only</option><option value="replace_all" ${val('import_nfo_policy')==='replace_all'?'selected':''}>Replace all</option></select></label>
          <div class="editor-actions"><button class="btn primary" id="save-automation">Save automation</button></div>
        </div>
      </div>

      <div class="card settings-section appearance-card accent-green-border">
        <div><h2>Appearance</h2><p class="muted">Theme is stored locally in this browser.</p></div>
        <div class="theme-segment"><button class="theme-choice" data-theme="light">☀︎ Light</button><button class="theme-choice" data-theme="dark">☾ Dark</button></div>
      </div>
    </div>`;

  bindCheckCardSelection(content);
  applyTheme(document.documentElement.dataset.theme || initialTheme());

  $$('.save-library').forEach(btn=>btn.onclick=async()=>{
    const row=btn.closest('.library-editor');
    const id=Number(row.dataset.libraryId);
    await api(`/api/libraries/${id}`,{method:'PUT',body:JSON.stringify({name:$('.lib-name',row).value,kind:$('.lib-kind',row).value,path:$('.lib-path',row).value,enabled:$('.lib-enabled',row).checked})});
    toast('Library saved','success');
    await renderSettings();
  });
  $$('.delete-library').forEach(btn=>btn.onclick=async()=>{
    const row=btn.closest('.library-editor');
    if(!confirm(`Delete library "${$('.lib-name',row).value}"?`)) return;
    await api(`/api/libraries/${row.dataset.libraryId}`,{method:'DELETE'});
    toast('Library deleted','success');
    await renderSettings();
  });
  $('#add-library').onclick=async()=>{
    await api('/api/libraries',{method:'POST',body:JSON.stringify({name:$('#new-lib-name').value,kind:$('#new-lib-kind').value,path:$('#new-lib-path').value,enabled:true})});
    toast('Library added','success');
    await renderSettings();
  };

  $$('.save-schedule').forEach(btn=>btn.onclick=async()=>{
    const row=btn.closest('.schedule-editor');
    await api(`/api/schedules/${row.dataset.scheduleId}`,{method:'PUT',body:JSON.stringify(collectSchedule(row))});
    toast('Schedule saved','success');
    await renderSettings();
  });
  $$('.delete-schedule').forEach(btn=>btn.onclick=async()=>{
    const row=btn.closest('.schedule-editor');
    if(!confirm(`Delete schedule "${$('.sched-name',row).value}"?`)) return;
    await api(`/api/schedules/${row.dataset.scheduleId}`,{method:'DELETE'});
    toast('Schedule deleted','success');
    await renderSettings();
  });
  $('#add-schedule').onclick=async()=>{
    const body={
      name:$('#new-sched-name').value,
      cron:$('#new-sched-cron').value,
      enabled:$('#new-sched-enabled').value==='true',
      apply_changes:$('#new-sched-apply').value==='true',
      nfo_policy:$('#new-sched-policy').value,
      library_ids:$$('.new-sched-lib:checked').map(x=>Number(x.value)),
    };
    await api('/api/schedules',{method:'POST',body:JSON.stringify(body)});
    toast('Schedule added','success');
    await renderSettings();
  };

  $('#save-sources').onclick=async()=>{
    const values={}; $$('.source-setting').forEach(el=>values[el.dataset.key]=el.value);
    await api('/api/settings',{method:'PUT',body:JSON.stringify({values})});
    toast('Sources saved','success');
  };
  $('#test-sources').onclick=async()=>{
    const r=await api('/api/sources/test',{method:'POST'});
    toast(Object.entries(r).map(([k,v])=>`${k}: ${v.ok?'OK':'FAIL'}`).join(' · '), Object.values(r).every(v=>v.ok)?'success':'warning');
  };
  $('#save-automation').onclick=async()=>{
    const values={}; $$('.automation-setting').forEach(el=>values[el.dataset.key]=el.value);
    await api('/api/settings',{method:'PUT',body:JSON.stringify({values})});
    toast('Automation saved','success');
  };
  $$('.theme-choice').forEach(btn=>btn.onclick=()=>applyTheme(btn.dataset.theme));
}

$$('.nav').forEach(b=>b.onclick=()=>navigate(b.dataset.view));
$('#refresh-btn').onclick=()=>navigate(currentView);
$('#theme-toggle').onclick=toggleTheme;
applyTheme(initialTheme());
navigate('dashboard');
