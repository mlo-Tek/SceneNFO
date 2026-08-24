const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];
const content = $('#content');
let currentView = 'dashboard';
let activeJob = null;
let liveRows = [];

const api = async (url, opts={}) => {
  const r = await fetch(url, {headers:{'Content-Type':'application/json', ...(opts.headers||{})}, ...opts});
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
const esc = v => String(v ?? '').replace(/[&<>'"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const toast = msg => { const t=$('#toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); };
const pill = c => `<span class="pill ${c}">${c==='scene'?'SCENE':c==='p2p'?'P2P':esc(c)}</span>`;
const policyLabel = p => p==='replace_all'?'Replace all Scene NFOs':'Only add missing NFOs';

const titles = {
  dashboard:['Dashboard','Your media release overview'], movies:['Movies','Movie library inventory'], tv:['TV Shows','TV episode inventory'],
  'groups-scene':['Scene Groups','Synced from PreDB.club'], 'groups-p2p':['P2P Groups','Curated German P2P release groups'],
  scan:['Live Scan','Scan a configured library'], history:['History','Previous manual, scheduled and import runs'], logs:['Logs','Scrollable application activity'], settings:['Settings','Libraries, schedules, sources and automation']
};

async function navigate(view){
  currentView=view; $$('.nav').forEach(b=>b.classList.toggle('active', b.dataset.view===view));
  $('#page-title').textContent=titles[view][0]; $('#page-subtitle').textContent=titles[view][1];
  if(view==='dashboard') return renderDashboard();
  if(view==='movies') return renderLibrary('movies');
  if(view==='tv') return renderLibrary('tv');
  if(view==='groups-scene') return renderGroups('scene');
  if(view==='groups-p2p') return renderGroups('p2p');
  if(view==='scan') return renderScan();
  if(view==='history') return renderHistory();
  if(view==='logs') return renderLogs();
  if(view==='settings') return renderSettings();
}

async function renderDashboard(){
  const d=await api('/api/dashboard');
  content.innerHTML=`
  <div class="grid stats">
    ${[['Movies',d.movies],['TV Episodes',d.tv],['Libraries',d.libraries],['Scene',d.scene],['P2P',d.p2p],['NFO Present',d.nfo]].map(x=>`<div class="card stat"><div class="k">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('')}
  </div>
  <div class="card section-card">
    <div class="section-head"><div><h2>Release classification</h2><p>Exact PreDB.club match = Scene. Everything else is shown as P2P.</p></div><button class="btn primary" onclick="navigate('scan')">Start Live Scan</button></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div><div class="muted">Scene share</div><div style="font-size:40px;font-weight:730;margin-top:6px">${d.scene+d.p2p?Math.round(d.scene/(d.scene+d.p2p)*100):0}%</div></div>
      <div><div class="muted">NFO coverage</div><div style="font-size:40px;font-weight:730;margin-top:6px">${d.movies+d.tv?Math.round(d.nfo/(d.movies+d.tv)*100):0}%</div></div>
    </div>
  </div>`;
}

async function renderLibrary(kind){
  const libs=await api(`/api/libraries?kind=${kind}`);
  content.innerHTML=`<div class="card section-card"><div class="section-head"><div><h2>${kind==='movies'?'Movies':'TV Shows'}</h2><p>Filter by configured library, release type, group and NFO state.</p></div></div>
  <div class="toolbar" style="margin-bottom:14px">
    <select id="lib-config"><option value="">All ${kind==='movies'?'movie':'TV'} libraries</option>${libs.map(l=>`<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
    <input id="lib-q" class="field" placeholder="Search title, release or group…">
    <select id="lib-class"><option value="">All types</option><option value="scene">Scene</option><option value="p2p">P2P</option></select>
    <select id="lib-nfo"><option value="">All NFO</option><option value="present">NFO present</option><option value="missing">NFO missing</option></select>
    <button class="btn secondary" id="lib-filter">Apply</button>
  </div><div id="lib-table"></div></div>`;
  const load=async()=>{
    const q=encodeURIComponent($('#lib-q').value), c=$('#lib-class').value, n=$('#lib-nfo').value, lid=$('#lib-config').value;
    const rows=await api(`/api/library/${kind}?q=${q}&classification=${c}&nfo=${n}&library_id=${lid}&limit=2000`);
    $('#lib-table').innerHTML=`<div class="table-wrap"><table><thead><tr><th>Library</th><th>Title</th><th>Type</th><th>Group</th><th>NFO</th><th>NFO Source</th><th>Result</th><th>Release</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.configured_library||'Legacy')}</td><td>${esc(r.title)}</td><td>${pill(r.classification)}</td><td>${esc(r.release_group||'Unknown')}</td><td>${r.nfo_present?'✓ Present':'— Missing'}</td><td>${esc(r.nfo_source||'Local / Unknown')}</td><td>${esc(r.last_result||'')}</td><td class="mono">${esc(r.release_name)}</td></tr>`).join('')}</tbody></table></div>`;
  };
  $('#lib-filter').onclick=load; $('#lib-q').addEventListener('keydown',e=>{if(e.key==='Enter')load()}); await load();
}

async function renderGroups(classification){
  content.innerHTML=`<div class="card section-card"><div class="section-head"><div><h2>${classification==='scene'?'Scene Groups':'P2P Groups'}</h2><p>${classification==='scene'?'The groups returned by PreDB.club /teams.':'Curated German P2P release groups.'}</p></div>${classification==='scene'?'<button class="btn secondary" id="sync-groups">Sync now</button>':'<button class="btn secondary" id="reseed-groups">Reload curated list</button>'}</div><div class="toolbar" style="margin-bottom:14px"><input id="group-q" class="field" placeholder="Search group or origin…"><button class="btn secondary" id="group-filter">Search</button></div><div id="groups-table"></div></div>`;
  const load=async()=>{
    const q=encodeURIComponent($('#group-q').value); const rows=await api(`/api/groups?classification=${classification}&q=${q}`);
    $('#groups-table').innerHTML=`<div class="table-wrap"><table><thead><tr><th>Group</th><th>Class</th><th>Active</th><th>Origin</th><th>Type</th><th>Aliases</th><th>Source</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.name)}</strong></td><td>${pill(r.classification)}</td><td>${esc(r.active||'—')}</td><td>${esc(r.origin||'—')}</td><td>${esc(r.distribution_type||'—')}</td><td>${esc(r.aliases||'—')}</td><td>${esc(r.source)}</td></tr>`).join('')}</tbody></table></div>`;
  };
  $('#group-filter').onclick=load; $('#group-q').addEventListener('keydown',e=>{if(e.key==='Enter')load()});
  if($('#sync-groups')) $('#sync-groups').onclick=async()=>{const x=await api('/api/groups/sync-scene',{method:'POST'});toast(`Synced ${x.synced} Scene groups`);load()};
  if($('#reseed-groups')) $('#reseed-groups').onclick=async()=>{const x=await api('/api/groups/reseed-p2p',{method:'POST'});toast(`Loaded ${x.seeded} P2P groups`);load()};
  await load();
}

async function renderScan(){
  const libs=(await api('/api/libraries')).filter(l=>l.enabled);
  content.innerHTML=`<div class="scan-panel"><div class="card section-card" style="margin-top:0"><h2 style="margin-top:0">New scan</h2>
  <div class="row"><label>Library<small>Select any configured library</small></label><select id="scan-library">${libs.map(l=>`<option value="${l.id}">${esc(l.name)} · ${esc(l.path)}</option>`).join('')}</select></div>
  <div class="row"><label>Mode<small>Dry Run never writes files</small></label><select id="scan-mode"><option value="false">Dry Run</option><option value="true">Apply</option></select></div>
  <div class="row"><label>NFO handling<small>Controls existing verified Scene NFOs</small></label><select id="scan-policy"><option value="replace_all">Replace all Scene NFOs</option><option value="missing_only">Only add missing NFOs</option></select></div>
  <div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" id="run-scan" ${libs.length?'':'disabled'}>Start Scan</button><button class="btn danger" id="stop-scan">Stop</button></div>
  <div style="margin-top:22px"><div class="muted" id="scan-status">${libs.length?'Ready':'No enabled libraries configured'}</div><div class="progress-shell" style="margin-top:9px"><div class="progress" id="scan-progress"></div></div><div id="scan-counts" style="margin-top:12px;font-size:13px"></div></div></div>
  <div class="card section-card" style="margin-top:0"><div class="section-head"><div><h2>Live results</h2><p>Updates arrive while the scan is running.</p></div></div><div class="live-list" id="live-list"></div></div></div>`;
  if(libs.length) $('#run-scan').onclick=()=>startLiveScan();
  $('#stop-scan').onclick=()=>activeJob&&api(`/api/scans/${activeJob}/stop`,{method:'POST'});
}

async function startLiveScan(){
  liveRows=[]; $('#live-list').innerHTML='';
  const library_id=Number($('#scan-library').value), apply=$('#scan-mode').value==='true', nfo_policy=$('#scan-policy').value;
  const x=await api('/api/scans',{method:'POST',body:JSON.stringify({library_id,apply,nfo_policy})}); activeJob=x.job_id; $('#scan-status').textContent='Starting…';
  const es=new EventSource(`/api/scans/${activeJob}/events`);
  es.onmessage=e=>{
    const d=JSON.parse(e.data);
    if(d.type==='start') $('#scan-status').textContent=`${d.library_name} · ${d.mode} · ${policyLabel(d.nfo_policy)}`;
    if(d.type==='inventory') $('#scan-status').textContent=`Found ${d.total} MKVs`;
    if(d.type==='item'){
      const pct=d.total?Math.round(d.index/d.total*100):0; $('#scan-progress').style.width=`${pct}%`; $('#scan-status').textContent=`${d.index} / ${d.total} · ${d.release}`;
      liveRows.unshift(d); liveRows=liveRows.slice(0,250); $('#live-list').innerHTML=liveRows.map(r=>`<div class="live-row"><span>${r.index}/${r.total}</span>${pill(r.classification)}<span class="mono">${esc(r.release)}</span><span>${esc(r.action||'')}</span></div>`).join('');
    }
    if(d.type==='item_error') $('#scan-status').textContent=`Error: ${d.message}`;
    if(d.type==='complete'){ $('#scan-progress').style.width='100%'; $('#scan-status').textContent=`Completed · ${d.library_name}`; $('#scan-counts').textContent=`${d.scene} Scene · ${d.p2p} P2P · ${d.created} created · ${d.replaced} replaced · ${d.errors} errors`; es.close(); toast('Scan completed'); }
    if(d.type==='fatal'||d.type==='cancelled'){ $('#scan-status').textContent=d.message; es.close(); }
  };
  es.onerror=()=>{ if(es.readyState===EventSource.CLOSED) return; $('#scan-status').textContent='Live connection interrupted'; };
}

async function renderHistory(){
  const rows=await api('/api/history?limit=250');
  content.innerHTML=`<div class="card section-card"><div class="section-head"><div><h2>Runs</h2><p>Manual, scheduled and import-triggered activity.</p></div></div><div class="table-wrap"><table><thead><tr><th>ID</th><th>Started</th><th>Library</th><th>Trigger</th><th>Mode</th><th>NFO handling</th><th>Status</th><th>Scanned</th><th>Scene</th><th>P2P</th><th>Created</th><th>Replaced</th><th>Errors</th></tr></thead><tbody>${rows.map(r=>`<tr><td>#${r.id}</td><td>${esc(r.started_at)}</td><td>${esc(r.library_name||r.library||'')}</td><td>${esc(r.trigger)}</td><td>${esc(r.mode)}</td><td>${esc(r.nfo_policy?policyLabel(r.nfo_policy):'')}</td><td>${esc(r.status)}</td><td>${r.scanned}</td><td>${r.scene}</td><td>${r.p2p}</td><td>${r.created}</td><td>${r.replaced}</td><td>${r.errors}</td></tr>`).join('')}</tbody></table></div></div>`;
}

async function renderLogs(){
  const rows=await api('/api/logs?limit=3000');
  content.innerHTML=`<div class="card section-card"><div class="section-head"><div><h2>Logs</h2><p>Newest events first.</p></div><button class="btn secondary" id="reload-logs">Reload</button></div><div class="logbox" id="logbox">${rows.map(r=>`<div class="logline ${String(r.level).toLowerCase()}">[${esc(r.ts)}] ${esc(r.level)} ${esc(r.library_name||r.library||'')} ${esc(r.event)} — ${esc(r.message)}</div>`).join('')}</div></div>`;
  $('#reload-logs').onclick=()=>renderLogs();
}

function libraryEditor(l){
  return `<div class="library-editor" data-library-id="${l.id}" style="padding:14px 0;border-bottom:1px solid var(--border,rgba(128,128,128,.2))">
    <div style="display:grid;grid-template-columns:1.1fr .7fr 2fr auto;gap:10px;align-items:center">
      <input class="field lib-name" value="${esc(l.name)}" aria-label="Library name">
      <select class="lib-kind"><option value="movies" ${l.kind==='movies'?'selected':''}>Movies</option><option value="tv" ${l.kind==='tv'?'selected':''}>TV</option></select>
      <input class="field lib-path mono" value="${esc(l.path)}" aria-label="Library path">
      <label style="display:flex;gap:6px;align-items:center;white-space:nowrap"><input type="checkbox" class="lib-enabled" ${l.enabled?'checked':''}> Enabled</label>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:9px"><button class="btn secondary save-library">Save</button><button class="btn danger delete-library">Delete</button></div>
  </div>`;
}

function libraryChecks(libs, selected=[]){
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;margin-top:8px">${libs.map(l=>`<label style="display:flex;gap:8px;align-items:center;padding:10px;border:1px solid rgba(128,128,128,.22);border-radius:10px"><input type="checkbox" class="schedule-lib" value="${l.id}" ${selected.includes(l.id)?'checked':''}><span><strong>${esc(l.name)}</strong><small style="display:block" class="muted">${esc(l.path)}</small></span></label>`).join('')}</div>`;
}

function scheduleEditor(s, libs, isNew=false){
  const id=isNew?'new':s.id, selected=s.library_ids||[];
  return `<div class="schedule-editor" data-schedule-id="${id}" style="padding:16px 0;border-bottom:1px solid rgba(128,128,128,.22)">
    <div style="display:grid;grid-template-columns:1.2fr 1fr .7fr .9fr .9fr;gap:10px;align-items:end">
      <div><small class="muted">Name</small><input class="field schedule-name" value="${esc(s.name||'')}"></div>
      <div><small class="muted">Cron</small><input class="field schedule-cron mono" value="${esc(s.cron||'0 3 * * *')}"></div>
      <div><small class="muted">Enabled</small><select class="schedule-enabled"><option value="false" ${!s.enabled?'selected':''}>Off</option><option value="true" ${s.enabled?'selected':''}>On</option></select></div>
      <div><small class="muted">Run mode</small><select class="schedule-apply"><option value="false" ${!s.apply_changes?'selected':''}>Dry Run</option><option value="true" ${s.apply_changes?'selected':''}>Apply</option></select></div>
      <div><small class="muted">NFO handling</small><select class="schedule-policy"><option value="missing_only" ${s.nfo_policy!=='replace_all'?'selected':''}>Missing only</option><option value="replace_all" ${s.nfo_policy==='replace_all'?'selected':''}>Replace all</option></select></div>
    </div>
    <div style="margin-top:12px"><small class="muted">Libraries included in this run</small>${libraryChecks(libs, selected)}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button class="btn ${isNew?'primary':'secondary'} save-schedule">${isNew?'Add Schedule':'Save'}</button>${isNew?'':'<button class="btn danger delete-schedule">Delete</button>'}</div>
  </div>`;
}

function schedulePayload(editor){
  return {
    name: $('.schedule-name',editor).value.trim(),
    cron: $('.schedule-cron',editor).value.trim(),
    enabled: $('.schedule-enabled',editor).value==='true',
    apply_changes: $('.schedule-apply',editor).value==='true',
    nfo_policy: $('.schedule-policy',editor).value,
    library_ids: $$('.schedule-lib:checked',editor).map(x=>Number(x.value))
  };
}

async function renderSettings(){
  const [s,libs,schedules]=await Promise.all([api('/api/settings'),api('/api/libraries'),api('/api/schedules')]);
  const val=k=>typeof s[k]==='object'?(s[k].value||''):s[k]??'';
  const newSchedule={name:'',cron:'0 3 * * *',enabled:false,apply_changes:false,nfo_policy:'missing_only',library_ids:[]};
  content.innerHTML=`<div class="settings-grid">
    <div class="card settings-group" style="grid-column:1/-1"><div class="section-head"><div><h3>Libraries</h3><p>Add, edit, disable or delete any media library.</p></div></div>
      <div id="libraries-list">${libs.map(l=>libraryEditor(l)).join('')}</div>
      <div style="margin-top:18px;padding-top:4px"><h4>Add library</h4><div style="display:grid;grid-template-columns:1.1fr .7fr 2fr auto;gap:10px;align-items:center"><input id="new-lib-name" class="field" placeholder="e.g. Anime"><select id="new-lib-kind"><option value="movies">Movies</option><option value="tv">TV</option></select><input id="new-lib-path" class="field mono" placeholder="/data/media/..."><button class="btn primary" id="add-library">Add</button></div></div>
    </div>

    <div class="card settings-group" style="grid-column:1/-1"><div class="section-head"><div><h3>Schedules</h3><p>Each scheduled run has its own libraries, run mode and NFO replacement policy.</p></div></div>
      <div id="schedules-list">${schedules.map(x=>scheduleEditor(x,libs,false)).join('')}${scheduleEditor(newSchedule,libs,true)}</div>
    </div>

    <div class="card settings-group"><h3>Sources</h3>
      <div class="row"><label>srrDB</label><input class="field setting" data-key="srrdb_base_url" value="${esc(val('srrdb_base_url'))}"></div>
      <div class="row"><label>PreDB.club</label><input class="field setting" data-key="predb_base_url" value="${esc(val('predb_base_url'))}"></div>
      <div class="row"><label>crowdNFO</label><input class="field setting" data-key="crowdnfo_base_url" value="${esc(val('crowdnfo_base_url'))}"></div>
      <div class="row"><label>crowdNFO API key<small>Stored encrypted</small></label><input type="password" class="field setting" data-key="crowdnfo_api_key" value="${esc(val('crowdnfo_api_key'))}" placeholder="API key"></div>
      <div class="row"><label>Priority<small>Comma-separated</small></label><input class="field setting" data-key="source_priority" value="${esc(val('source_priority'))}"></div>
      <button class="btn secondary" id="test-sources" style="margin-top:14px">Test Connections</button>
    </div>

    <div class="card settings-group"><h3>Import automation</h3>
      <div class="row"><label>Radarr webhook</label><select class="setting" data-key="radarr_webhook_enabled"><option value="true" ${val('radarr_webhook_enabled')==='true'?'selected':''}>Enabled</option><option value="false" ${val('radarr_webhook_enabled')==='false'?'selected':''}>Disabled</option></select></div>
      <div class="row"><label>Sonarr webhook</label><select class="setting" data-key="sonarr_webhook_enabled"><option value="true" ${val('sonarr_webhook_enabled')==='true'?'selected':''}>Enabled</option><option value="false" ${val('sonarr_webhook_enabled')==='false'?'selected':''}>Disabled</option></select></div>
      <div class="row"><label>Import action</label><select class="setting" data-key="import_apply"><option value="false" ${val('import_apply')!=='true'?'selected':''}>Scan only</option><option value="true" ${val('import_apply')==='true'?'selected':''}>Apply</option></select></div>
      <div class="row"><label>NFO handling</label><select class="setting" data-key="import_nfo_policy"><option value="replace_all" ${val('import_nfo_policy')!=='missing_only'?'selected':''}>Replace all Scene NFOs</option><option value="missing_only" ${val('import_nfo_policy')==='missing_only'?'selected':''}>Only add missing NFOs</option></select></div>
      <div style="margin-top:12px;font-size:12px" class="muted">Radarr: POST /api/webhooks/radarr<br>Sonarr: POST /api/webhooks/sonarr</div>
    </div>
  </div><div style="margin-top:18px;display:flex;justify-content:flex-end"><button class="btn primary" id="save-settings">Save Source & Automation Settings</button></div>`;

  $('#add-library').onclick=async()=>{
    const body={name:$('#new-lib-name').value.trim(),kind:$('#new-lib-kind').value,path:$('#new-lib-path').value.trim(),enabled:true};
    await api('/api/libraries',{method:'POST',body:JSON.stringify(body)}); toast('Library added'); renderSettings();
  };
  $$('.library-editor').forEach(ed=>{
    $('.save-library',ed).onclick=async()=>{const id=ed.dataset.libraryId;const body={name:$('.lib-name',ed).value.trim(),kind:$('.lib-kind',ed).value,path:$('.lib-path',ed).value.trim(),enabled:$('.lib-enabled',ed).checked};await api(`/api/libraries/${id}`,{method:'PUT',body:JSON.stringify(body)});toast('Library saved');renderSettings()};
    $('.delete-library',ed).onclick=async()=>{if(!confirm(`Delete library “${$('.lib-name',ed).value}”?`))return;await api(`/api/libraries/${ed.dataset.libraryId}`,{method:'DELETE'});toast('Library deleted');renderSettings()};
  });
  $$('.schedule-editor').forEach(ed=>{
    $('.save-schedule',ed).onclick=async()=>{const payload=schedulePayload(ed);const isNew=ed.dataset.scheduleId==='new';await api(isNew?'/api/schedules':`/api/schedules/${ed.dataset.scheduleId}`,{method:isNew?'POST':'PUT',body:JSON.stringify(payload)});toast(isNew?'Schedule added':'Schedule saved');renderSettings()};
    const del=$('.delete-schedule',ed); if(del) del.onclick=async()=>{if(!confirm('Delete this schedule?'))return;await api(`/api/schedules/${ed.dataset.scheduleId}`,{method:'DELETE'});toast('Schedule deleted');renderSettings()};
  });
  $('#save-settings').onclick=async()=>{const values={}; $$('.setting').forEach(el=>values[el.dataset.key]=el.value); await api('/api/settings',{method:'PUT',body:JSON.stringify({values})});toast('Settings saved')};
  $('#test-sources').onclick=async()=>{const r=await api('/api/sources/test',{method:'POST'});toast(Object.entries(r).map(([k,v])=>`${k}: ${v.ok?'OK':'FAIL'}`).join(' · '))};
}

$$('.nav').forEach(b=>b.onclick=()=>navigate(b.dataset.view));
$('#refresh-btn').onclick=()=>navigate(currentView);
$('#quick-scan').onclick=()=>navigate('scan');
navigate('dashboard');
