(() => {
  const h = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const dateFmt = new Intl.DateTimeFormat('de-DE', {year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const localTime = value => {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : dateFmt.format(d);
  };
  const triggerLabel = trigger => {
    const t = String(trigger || '');
    if (t === 'manual') return 'Manual';
    if (t === 'radarr-import') return 'Radarr import';
    if (t === 'radarr-upgrade') return 'Radarr upgrade';
    if (t === 'sonarr-import') return 'Sonarr import';
    if (t === 'sonarr-upgrade') return 'Sonarr upgrade';
    if (t === 'sonarr-import-batch') return 'Sonarr import batch';
    if (t === 'sonarr-upgrade-batch') return 'Sonarr upgrade batch';
    if (t === 'sonarr-import-complete') return 'Sonarr import';
    if (t.startsWith('schedule:')) return `Schedule · ${t.slice(9)}`;
    if (t.startsWith('review-apply:')) return `Review apply · #${t.slice(13)}`;
    return t || 'Unknown';
  };
  const modeLabel = mode => mode === 'apply' ? 'Apply' : mode === 'dry-run' ? 'Dry Run' : (mode || '—');
  const scopeLabel = scope => scope === 'full' ? 'Full rescan' : 'New / changed only';
  const policyLabel = p => p === 'replace_all' ? 'Replace all' : p === 'missing_only' ? 'Missing only' : (p || '—');
  const sourceLabel = source => ({srrdb:'srrDB',predb:'PreDB.club',crowdnfo:'crowdNFO'})[String(source || '').toLowerCase()] || source || '—';

  let viewController = null;
  let viewSerial = 0;
  const beginViewRequest = () => {
    if (viewController) viewController.abort();
    viewController = new AbortController();
    viewSerial += 1;
    return {signal:viewController.signal, serial:viewSerial};
  };
  const perfJson = async (url, opts={}) => {
    const response = await fetch(url, opts);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };

  const originalNavigate = typeof navigate === 'function' ? navigate : null;
  if (originalNavigate) {
    navigate = async function(view){
      beginViewRequest();
      return originalNavigate(view);
    };
  }

  // Fix stale group requests writing into a view that no longer exists.
  let groupSerial = 0;
  if (typeof renderGroups === 'function') {
    renderGroups = async function(classification){
      const serial = ++groupSerial;
      const expectedView = classification === 'scene' ? 'groups-scene' : 'groups-p2p';
      content.innerHTML = `<div class="card section-card"><div class="section-head"><div><h2>${classification==='scene'?'Scene Groups':'P2P Groups'}</h2><p>${classification==='scene'?'Synced from PreDB.club.':'Curated P2P release groups.'}</p></div>${classification==='scene'?'<button class="btn secondary" id="sync-groups">Sync now</button>':'<button class="btn secondary" id="reseed-groups">Reload curated list</button>'}</div><div class="toolbar"><input id="group-q" class="field grow" placeholder="Search group or origin…"><button class="btn secondary" id="group-filter">Search</button></div><div id="groups-table" class="table-space"></div></div>`;
      const load = async () => {
        const root = document.querySelector('#groups-table');
        if (!root) return;
        const q = encodeURIComponent(document.querySelector('#group-q')?.value || '');
        const rows = await api(`/api/groups?classification=${classification}&q=${q}`);
        if (serial !== groupSerial || currentView !== expectedView) return;
        const target = document.querySelector('#groups-table');
        if (!target) return;
        target.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Group</th><th>Class</th><th>Active</th><th>Origin</th><th>Type</th><th>Aliases</th><th>Source</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${h(r.name)}</strong></td><td>${pill(r.classification)}</td><td>${h(r.active||'—')}</td><td>${h(r.origin||'—')}</td><td>${h(r.distribution_type||'—')}</td><td>${h(r.aliases||'—')}</td><td>${h(r.source)}</td></tr>`).join('')}</tbody></table></div>`;
      };
      document.querySelector('#group-filter')?.addEventListener('click', load);
      document.querySelector('#group-q')?.addEventListener('keydown', event => { if (event.key === 'Enter') load(); });
      document.querySelector('#sync-groups')?.addEventListener('click', async () => { const x=await api('/api/groups/sync-scene',{method:'POST'}); toast(`Synced ${x.synced} Scene groups`); load(); });
      document.querySelector('#reseed-groups')?.addEventListener('click', async () => { const x=await api('/api/groups/reseed-p2p',{method:'POST'}); toast(`Loaded ${x.seeded} P2P groups`); load(); });
      await load();
    };
  }

  function categoryLabel(category){
    return ({all:'All',manual:'Manual',imports:'Imports',schedules:'Schedules',review:'Review applies'})[category] || category;
  }

  function historyRow(run){
    const status = String(run.status || '').toLowerCase();
    return `<div class="history-list-row">
      <div class="history-time"><span class="history-cell-label">Date / time</span><strong>${h(localTime(run.started_at))}</strong><small>Run #${Number(run.id)}</small></div>
      <div class="history-kind"><span class="history-cell-label">Run</span><strong>${h(triggerLabel(run.trigger))}</strong><span>${h(run.library_name || run.library || 'Unknown library')}</span></div>
      <div><span class="history-cell-label">Mode</span><span class="summary-chip">${h(modeLabel(run.mode))}</span></div>
      <div><span class="history-cell-label">NFO</span><span class="summary-chip">${h(policyLabel(run.nfo_policy))}</span></div>
      <div><span class="history-cell-label">Result</span><div class="history-metric-line"><span><strong>${Number(run.scanned||0)}</strong> scanned</span><span><strong>${Number(run.scene||0)}</strong> Scene</span><span><strong>${Number(run.p2p||0)}</strong> P2P</span><span><strong>${Number(run.errors||0)}</strong> errors</span><span>${h(scopeLabel(run.scan_scope))}</span><span class="history-status ${h(status)}">${h(run.status||'—')}</span></div></div>
      <button class="btn secondary history-open-log" data-run-id="${Number(run.id)}">Open logs</button>
    </div>`;
  }

  if (typeof renderHistory === 'function') {
    renderHistory = async function(){
      const serial = viewSerial;
      const state = {category:'all', library_id:'', q:'', page:0, limit:25};
      content.innerHTML = `<div class="card section-card history-performance-card"><div class="section-head"><div><h2>Run history</h2><p>Compact overview of manual, import, scheduled and review runs. Run IDs are secondary; the trigger, library and result are the important parts.</p></div><span class="pill info" id="history-total-pill">— RUNS</span></div><div id="history-workspace"><div class="empty-state">Loading history…</div></div></div>`;
      let libraries = [];
      try { libraries = await api('/api/libraries'); } catch {}
      if (currentView !== 'history' || serial !== viewSerial) return;
      const workspace = document.querySelector('#history-workspace');
      if (!workspace) return;
      workspace.innerHTML = `<div class="history-filterbar">
        <div class="history-category-tabs">${['all','manual','imports','schedules','review'].map(c=>`<button class="history-category-tab ${c==='all'?'active':''}" data-category="${c}">${categoryLabel(c)}</button>`).join('')}</div>
        <select id="history-library"><option value="">All libraries</option>${libraries.map(lib=>`<option value="${Number(lib.id)}">${h(lib.name)}</option>`).join('')}</select>
        <input id="history-search" class="field" type="search" placeholder="Search run, library or #ID…">
        <select id="history-page-size"><option value="25" selected>25 rows</option><option value="50">50 rows</option></select>
      </div><div id="history-list-area"></div>`;

      let searchTimer = null;
      const load = async () => {
        const token = ++state.token || (state.token = 1);
        const params = new URLSearchParams({limit:String(state.limit),offset:String(state.page*state.limit),category:state.category});
        if (state.library_id) params.set('library_id', state.library_id);
        if (state.q) params.set('q', state.q);
        const data = await perfJson(`/api/performance/history?${params}`);
        if (currentView !== 'history' || token !== state.token) return;
        const area = document.querySelector('#history-list-area');
        if (!area) return;
        document.querySelector('#history-total-pill').textContent = `${data.total} RUNS`;
        const start = data.total ? state.page*state.limit+1 : 0;
        const end = Math.min((state.page+1)*state.limit, data.total);
        const pages = Math.max(1, Math.ceil(data.total/state.limit));
        area.innerHTML = `<div class="history-list"><div class="history-list-head"><span>Date / time</span><span>Run / library</span><span>Mode</span><span>NFO</span><span>Result</span><span></span></div>${data.items.map(historyRow).join('') || '<div class="empty-state">No matching runs.</div>'}</div><div class="history-pager"><div class="history-pager-left">${start}–${end} of ${data.total}</div><div class="history-pager-actions"><button class="btn secondary" id="history-prev" ${state.page<=0?'disabled':''}>Previous</button><span class="history-page-chip">Page ${state.page+1} / ${pages}</span><button class="btn secondary" id="history-next" ${(state.page+1)>=pages?'disabled':''}>Next</button></div></div>`;
        area.querySelectorAll('.history-open-log').forEach(button => button.addEventListener('click', async () => {
          sessionStorage.setItem('scenenfo-open-run-id', button.dataset.runId);
          await navigate('logs');
        }));
        area.querySelector('#history-prev')?.addEventListener('click', () => { state.page=Math.max(0,state.page-1); load(); });
        area.querySelector('#history-next')?.addEventListener('click', () => { state.page+=1; load(); });
      };

      workspace.querySelectorAll('.history-category-tab').forEach(button => button.addEventListener('click', () => {
        state.category = button.dataset.category; state.page = 0;
        workspace.querySelectorAll('.history-category-tab').forEach(x=>x.classList.toggle('active',x===button));
        load();
      }));
      workspace.querySelector('#history-library').addEventListener('change', event => { state.library_id=event.target.value; state.page=0; load(); });
      workspace.querySelector('#history-page-size').addEventListener('change', event => { state.limit=Number(event.target.value)||25; state.page=0; load(); });
      workspace.querySelector('#history-search').addEventListener('input', event => { clearTimeout(searchTimer); searchTimer=setTimeout(()=>{state.q=event.target.value.trim();state.page=0;load();},220); });
      await load();
    };
  }

  function nfoBefore(payload){
    const action = String(payload.action || '').toUpperCase();
    if (['WOULD_CREATE','CREATED'].includes(action)) return false;
    if (['WOULD_REPLACE','REPLACED_IDENTICAL','REPLACED_CHANGED','WOULD_SKIP_PRESENT','SKIPPED_PRESENT'].includes(action)) return true;
    return Boolean(payload.nfo_present);
  }
  function decision(payload){
    const action = String(payload.action || '').toUpperCase();
    const source = payload.nfo_source ? ` · ${sourceLabel(payload.nfo_source)}` : '';
    if (action === 'P2P') return ['NFO untouched · P2P','p2p'];
    if (action === 'WOULD_CREATE') return [`Would download + create${source}`,'planned'];
    if (action === 'WOULD_REPLACE') return [`Would download + replace${source}`,'planned'];
    if (action === 'WOULD_SKIP_PRESENT') return ['Would keep existing NFO',''];
    if (action === 'CREATED') return [`Downloaded + created${source}`,'success'];
    if (action === 'REPLACED_IDENTICAL') return [`Downloaded + replaced · identical${source}`,'success'];
    if (action === 'REPLACED_CHANGED') return [`Downloaded + replaced · changed${source}`,'success'];
    if (action === 'SKIPPED_PRESENT') return ['Existing NFO kept',''];
    if (action === 'NO_SOURCE') return ['No usable NFO source found','warning'];
    return [action || 'No NFO action',''];
  }
  function eventRow(row, run){
    let payload = {}; try { payload = JSON.parse(row.payload || '{}'); } catch {}
    let body = h(row.message || '');
    if (row.event === 'item') {
      const cls = String(payload.classification || '').toLowerCase();
      const [action, actionCls] = decision(payload);
      body = `<div class="logs-event-release">${h(payload.release || row.message || '')}</div><div class="logs-event-facts"><span class="logs-event-fact">${h(triggerLabel(run.trigger))}</span><span class="logs-event-fact">${h(modeLabel(run.mode))}</span>${cls?`<span class="logs-event-fact ${h(cls)}">${h(cls.toUpperCase())}</span>`:''}${payload.group?`<span class="logs-event-fact">Group: ${h(payload.group)}</span>`:''}<span class="logs-event-fact">NFO before: ${nfoBefore(payload)?'present':'missing'}</span><span class="logs-event-fact ${h(actionCls)}">${h(action)}</span></div>`;
    }
    return `<div class="logs-event"><span class="logs-event-time">${h(localTime(row.ts))}</span><span class="logs-event-level">${h(row.level)}</span><span class="logs-event-kind">${h(row.event)}</span><div class="logs-event-message">${body}</div></div>`;
  }
  function runSummaryHtml(run){
    return `<div class="logs-summary"><div class="logs-summary-item"><span>Run type</span><strong>${h(triggerLabel(run.trigger))}</strong></div><div class="logs-summary-item"><span>Library</span><strong>${h(run.library_name||run.library||'—')}</strong></div><div class="logs-summary-item"><span>Mode</span><strong>${h(modeLabel(run.mode))}</strong></div><div class="logs-summary-item"><span>Scope</span><strong>${h(scopeLabel(run.scan_scope))}</strong></div><div class="logs-summary-item"><span>NFO</span><strong>${h(policyLabel(run.nfo_policy))}</strong></div><div class="logs-summary-item"><span>Status</span><strong>${h(run.status||'—')}</strong></div></div>`;
  }

  const downloadText = (name,text) => { const blob=new Blob([text],{type:'text/plain;charset=utf-8'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000); };

  if (typeof renderLogs === 'function') {
    renderLogs = async function(){
      const serial = viewSerial;
      content.innerHTML = `<div class="card section-card logs-performance-card"><div class="section-head"><div><h2>Logs</h2><p>Runs load on demand. Only the newest 200 events are loaded initially; older events can be appended when needed.</p></div></div><div id="logs-performance-root"><div class="empty-state">Loading runs…</div></div></div>`;
      const data = await perfJson('/api/performance/history?limit=100&offset=0&category=all');
      if (currentView !== 'logs' || serial !== viewSerial) return;
      const root = document.querySelector('#logs-performance-root'); if (!root) return;
      const pending = Number(sessionStorage.getItem('scenenfo-open-run-id') || 0); sessionStorage.removeItem('scenenfo-open-run-id');
      let runs = data.items || [];
      let selectedId = pending || Number(runs[0]?.id || 0);
      if (pending && !runs.some(r=>Number(r.id)===pending)) {
        try { const extra=await perfJson(`/api/performance/runs/${pending}`); runs=[extra,...runs]; } catch {}
      }
      root.innerHTML = `<div class="logs-shell"><aside class="logs-run-list"><h3>Select run</h3><p>Latest runs only. Use History to open older runs directly.</p><select class="logs-run-select" id="perf-run-select">${runs.map(r=>`<option value="${Number(r.id)}" ${Number(r.id)===selectedId?'selected':''}>${h(localTime(r.started_at))} · ${h(triggerLabel(r.trigger))} · ${h(r.library_name||r.library||'—')}</option>`).join('')}</select></aside><section class="logs-main" id="perf-log-main"><div class="empty-state">Select a run.</div></section></div>`;
      const select = root.querySelector('#perf-run-select');
      let loadRunToken = 0;

      const loadRun = async runId => {
        const token = ++loadRunToken;
        const main = document.querySelector('#perf-log-main'); if (!main) return;
        main.innerHTML = '<div class="empty-state">Loading run…</div>';
        const run = await perfJson(`/api/performance/runs/${runId}`);
        if (token !== loadRunToken || currentView !== 'logs') return;
        main.innerHTML = `<div class="section-head"><div><h2>${h(triggerLabel(run.trigger))}</h2><p>${h(localTime(run.started_at))} · Run #${Number(run.id)}</p></div><span class="pill ${run.status==='completed'?'scene':'info'}">${h(run.status||'—')}</span></div>${runSummaryHtml(run)}<div class="logs-tabs"><button class="logs-tab active" data-tab="events">Events</button><button class="logs-tab" data-tab="review">NFO review</button></div><div id="perf-log-tab-content"></div>`;
        let activeTab = 'events';
        const tabContent = main.querySelector('#perf-log-tab-content');
        const tabs = main.querySelectorAll('.logs-tab');

        const eventState = {offset:0,limit:200,order:'desc',event_type:'all',errors:false,q:'',token:0};
        let searchTimer;
        const renderEventsShell = () => {
          tabContent.innerHTML = `<div class="logs-toolbar-v2"><input id="perf-log-q" class="field" type="search" placeholder="Search release, group or message…"><select id="perf-log-type"><option value="all">All events</option></select><select id="perf-log-order"><option value="desc">Newest first</option><option value="asc">Oldest first</option></select><label class="logs-error-toggle-v2"><input id="perf-log-errors" type="checkbox"> Errors only</label><button class="btn secondary" id="perf-log-export">Export full log</button></div><div class="logs-events" id="perf-log-events"></div><div class="logs-load-more" id="perf-log-load-more"></div>`;
          tabContent.querySelector('#perf-log-q').addEventListener('input', event => { clearTimeout(searchTimer); searchTimer=setTimeout(()=>{eventState.q=event.target.value.trim();eventState.offset=0;loadEvents(false);},220); });
          tabContent.querySelector('#perf-log-type').addEventListener('change', event => {eventState.event_type=event.target.value;eventState.offset=0;loadEvents(false);});
          tabContent.querySelector('#perf-log-order').addEventListener('change', event => {eventState.order=event.target.value;eventState.offset=0;loadEvents(false);});
          tabContent.querySelector('#perf-log-errors').addEventListener('change', event => {eventState.errors=event.target.checked;eventState.offset=0;loadEvents(false);});
          tabContent.querySelector('#perf-log-export').addEventListener('click', async () => {
            const button=tabContent.querySelector('#perf-log-export'); button.disabled=true; button.textContent='Preparing…';
            try {
              const rows=await api(`/api/history/${run.id}/events?limit=10000`);
              const lines=[`SceneNFO run #${run.id}`,`Run: ${triggerLabel(run.trigger)}`,`Library: ${run.library_name||run.library||'—'}`,`Mode: ${modeLabel(run.mode)}`,`NFO: ${policyLabel(run.nfo_policy)}`,'',...rows.map(x=>`${localTime(x.ts)} | ${x.level} | ${x.event} | ${x.message}`)];
              downloadText(`SceneNFO-run-${run.id}.log`,lines.join('\n'));
            } finally { button.disabled=false;button.textContent='Export full log'; }
          });
        };
        const loadEvents = async append => {
          const token = ++eventState.token;
          const params=new URLSearchParams({limit:String(eventState.limit),offset:String(eventState.offset),order:eventState.order,event_type:eventState.event_type,errors_only:String(eventState.errors)}); if(eventState.q)params.set('q',eventState.q);
          const page=await perfJson(`/api/performance/runs/${run.id}/events?${params}`);
          if(token!==eventState.token||activeTab!=='events'||currentView!=='logs')return;
          const list=tabContent.querySelector('#perf-log-events'); if(!list)return;
          const html=page.items.map(row=>eventRow(row,run)).join('');
          if(append) list.insertAdjacentHTML('beforeend',html); else list.innerHTML=html||'<div class="logs-empty">No matching events.</div>';
          const type=tabContent.querySelector('#perf-log-type'); if(type&&type.options.length===1){ page.event_types.forEach(kind=>type.insertAdjacentHTML('beforeend',`<option value="${h(kind)}">${h(kind)}</option>`)); type.value=eventState.event_type; }
          const more=tabContent.querySelector('#perf-log-load-more'); const loaded=Math.min(eventState.offset+page.items.length,page.total); more.innerHTML=loaded<page.total?`<button class="btn secondary" id="perf-load-more-btn">Load older · ${loaded}/${page.total}</button>`:`<span class="summary-chip">${loaded}/${page.total} events loaded</span>`; more.querySelector('#perf-load-more-btn')?.addEventListener('click',()=>{eventState.offset+=eventState.limit;loadEvents(true);});
          const badge=main.querySelector('.section-head .pill'); if(badge) badge.title=`${page.absolute_total} total events`;
        };

        let reviewLoaded=false;
        const loadReview = async () => {
          if(reviewLoaded)return; reviewLoaded=true; tabContent.innerHTML='<div class="logs-review-placeholder">Loading NFO candidates…</div>';
          const data=await api(`/api/history/${run.id}/candidates`); const candidates=data.candidates||[];
          if(activeTab!=='review'||currentView!=='logs')return;
          if(!candidates.length){tabContent.innerHTML='<div class="logs-review-placeholder">This run has no NFO create/replace candidates.</div>';return;}
          tabContent.innerHTML=`<div class="logs-review-actions"><input id="perf-review-q" class="field grow" placeholder="Search NFO candidates…"><span class="summary-chip" id="perf-review-count">0 selected</span><button class="btn secondary" id="perf-review-select-visible">Select visible</button><button class="btn warning" id="perf-review-apply-selected" disabled>Apply selected</button><button class="btn danger" id="perf-review-apply-all">Apply all ${candidates.length}</button></div><div class="logs-review-list" id="perf-review-list">${candidates.map(c=>`<label class="logs-review-row" data-search="${h(`${c.title} ${c.release} ${c.group||''}`.toLowerCase())}"><input type="checkbox" class="perf-review-cb" value="${h(c.media_path)}"><div><div class="logs-review-title">${h(c.title)}</div><div class="logs-review-release">${h(c.release)}</div><div class="logs-review-meta"><span class="pill scene">SCENE</span><span class="summary-chip">${h(c.action)}</span><span class="summary-chip">Source: ${h(sourceLabel(c.nfo_source))}</span>${c.group?`<span class="summary-chip">Group: ${h(c.group)}</span>`:''}</div></div><span class="candidate-action">${c.nfo_present?'NFO present':'NFO missing'}</span></label>`).join('')}</div>`;
          const sync=()=>{const n=tabContent.querySelectorAll('.perf-review-cb:checked').length;tabContent.querySelector('#perf-review-count').textContent=`${n} selected`;tabContent.querySelector('#perf-review-apply-selected').disabled=!n;};
          tabContent.querySelectorAll('.perf-review-cb').forEach(cb=>cb.addEventListener('change',sync));
          tabContent.querySelector('#perf-review-q').addEventListener('input',event=>{const q=event.target.value.trim().toLowerCase();tabContent.querySelectorAll('.logs-review-row').forEach(row=>row.hidden=!!q&&!row.dataset.search.includes(q));});
          tabContent.querySelector('#perf-review-select-visible').addEventListener('click',()=>{tabContent.querySelectorAll('.logs-review-row:not([hidden]) .perf-review-cb').forEach(cb=>cb.checked=true);sync();});
          const apply=async applyAll=>{const paths=applyAll?[]:[...tabContent.querySelectorAll('.perf-review-cb:checked')].map(cb=>cb.value);const result=await api(`/api/history/${run.id}/apply`,{method:'POST',body:JSON.stringify({media_paths:paths,apply_all:applyAll})});toast(`Started ${result.started} NFO apply job${result.started===1?'':'s'}`,'success');};
          tabContent.querySelector('#perf-review-apply-selected').addEventListener('click',()=>apply(false).catch(err=>toast(String(err),'error'))); tabContent.querySelector('#perf-review-apply-all').addEventListener('click',()=>apply(true).catch(err=>toast(String(err),'error')));
        };

        tabs.forEach(button=>button.addEventListener('click',()=>{activeTab=button.dataset.tab;tabs.forEach(x=>x.classList.toggle('active',x===button));if(activeTab==='events'){renderEventsShell();eventState.offset=0;loadEvents(false);}else{loadReview();}}));
        renderEventsShell(); await loadEvents(false);
      };
      select.addEventListener('change',()=>loadRun(Number(select.value)));
      if(selectedId) await loadRun(selectedId);
    };
  }
})();
