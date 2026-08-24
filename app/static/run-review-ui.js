(() => {
  const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';
  const dateFmt = new Intl.DateTimeFormat('de-DE', {
    year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  });
  const localTime = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : dateFmt.format(d);
  };
  const triggerLabel = trigger => {
    const t = String(trigger || '');
    if (t === 'manual') return 'Manual';
    if (t === 'radarr-import') return 'Radarr import';
    if (t === 'sonarr-import-complete') return 'Sonarr import';
    if (t.startsWith('schedule:')) return `Schedule · ${t.slice(9)}`;
    if (t.startsWith('review-apply:')) return `Review apply · source #${t.slice(13)}`;
    return t || 'Unknown';
  };
  const modeLabel = mode => mode === 'apply' ? 'Apply' : mode === 'dry-run' ? 'Dry Run' : (mode || '—');
  const scopeLabel = scope => scope === 'full' ? 'Full rescan' : 'New / changed only';
  const policyLabel = p => p === 'replace_all' ? 'Replace all' : p === 'missing_only' ? 'Missing only' : (p || '—');
  const runOption = r => `#${r.id} · ${localTime(r.started_at)} · ${triggerLabel(r.trigger)} · ${r.library_name || r.library || '—'} · ${modeLabel(r.mode)} · ${r.status}`;

  async function getJson(url, opts={}) {
    const response = await fetch(url, {
      headers:{'Content-Type':'application/json', ...(opts.headers || {})},
      ...opts,
    });
    if (!response.ok) {
      let text = await response.text();
      try { text = JSON.parse(text).detail || text; } catch {}
      throw new Error(String(text));
    }
    return response.status === 204 ? null : response.json();
  }

  function metaHtml(run) {
    return `
      <div class="run-meta">
        <div class="run-meta-item"><span>Date / time</span><strong>${e(localTime(run.started_at))}</strong></div>
        <div class="run-meta-item"><span>Run type</span><strong>${e(triggerLabel(run.trigger))}</strong></div>
        <div class="run-meta-item"><span>Library</span><strong>${e(run.library_name || run.library || '—')}</strong></div>
        <div class="run-meta-item"><span>Mode</span><strong>${e(modeLabel(run.mode))}</strong></div>
        <div class="run-meta-item"><span>Scan scope</span><strong>${e(scopeLabel(run.scan_scope))}</strong></div>
        <div class="run-meta-item"><span>NFO handling</span><strong>${e(policyLabel(run.nfo_policy))}</strong></div>
      </div>
      <div class="run-summary">
        <span class="summary-chip">Status: ${e(run.status)}</span>
        <span class="summary-chip">Scanned: ${Number(run.scanned || 0)}</span>
        <span class="summary-chip">Scene: ${Number(run.scene || 0)}</span>
        <span class="summary-chip">P2P: ${Number(run.p2p || 0)}</span>
        <span class="summary-chip">Created: ${Number(run.created || 0)}</span>
        <span class="summary-chip">Replaced: ${Number(run.replaced || 0)}</span>
        <span class="summary-chip">Errors: ${Number(run.errors || 0)}</span>
        <span class="summary-chip">Unchanged: ${Number(run.skipped || 0)}</span>
        <span class="summary-chip">Removed: ${Number(run.removed || 0)}</span>
      </div>`;
  }

  function eventHtml(row) {
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch {}
    const suffix = [payload.classification ? String(payload.classification).toUpperCase() : '', payload.action || ''].filter(Boolean).join(' · ');
    const message = `${row.message || ''}${suffix ? `  [${suffix}]` : ''}`;
    return `<div class="event-row">
      <span class="event-time">${e(localTime(row.ts))}</span>
      <span class="event-level ${e(String(row.level || '').toLowerCase())}">${e(row.level || '')}</span>
      <span class="event-kind">${e(row.event || '')}</span>
      <span class="event-message">${e(message)}</span>
    </div>`;
  }

  function candidateHtml(c) {
    const sources = Object.entries(c.source_status || {}).map(([k,v]) => `${k}: ${v}`).join(' · ');
    return `<label class="candidate-row" data-search="${e(`${c.title} ${c.release} ${c.group || ''}`.toLowerCase())}">
      <input type="checkbox" class="review-candidate" value="${e(c.media_path)}">
      <span>
        <span class="candidate-title">${e(c.title)}</span>
        <span class="candidate-release">${e(c.release)}</span>
        <span class="candidate-meta">
          <span class="pill scene">SCENE</span>
          <span class="candidate-action">${e(c.action)}</span>
          <span class="summary-chip">Source: ${e(c.nfo_source || 'none')}</span>
          ${c.group ? `<span class="summary-chip">Group: ${e(c.group)}</span>` : ''}
        </span>
        ${sources ? `<span class="candidate-release">${e(sources)}</span>` : ''}
        ${c.target ? `<span class="candidate-release">Target: ${e(c.target)}</span>` : ''}
      </span>
      <span class="candidate-action">${c.nfo_present ? 'NFO present' : 'NFO missing'}</span>
    </label>`;
  }

  function bindCandidateCards(root) {
    root.querySelectorAll('.candidate-row input').forEach(cb => cb.addEventListener('change', () => {
      cb.closest('.candidate-row')?.classList.toggle('selected', cb.checked);
      updateSelectedCount(root);
    }));
  }

  function updateSelectedCount(root) {
    const n = root.querySelectorAll('.review-candidate:checked').length;
    const el = root.querySelector('#review-selected-count');
    if (el) el.textContent = `${n} selected`;
  }

  function monitorApplyJobs(jobs, box) {
    if (!jobs.length) return;
    const states = new Map(jobs.map(j => [j.job_id, {done:false, title:j.title, action:'Starting…'}]));
    const render = () => {
      const done = [...states.values()].filter(x => x.done).length;
      box.innerHTML = `<strong>Apply progress: ${done}/${states.size}</strong>${[...states.values()].map(x => `
        <div class="apply-job"><strong>${e(x.title)}</strong><span class="${x.error?'apply-error':x.done?'apply-ok':''}">${e(x.action)}</span></div>`).join('')}`;
    };
    render();
    jobs.forEach(job => {
      const es = new EventSource(`/api/scans/${job.job_id}/events`);
      es.onmessage = event => {
        let data = {};
        try { data = JSON.parse(event.data); } catch { return; }
        const state = states.get(job.job_id);
        if (!state) return;
        if (data.type === 'item') state.action = data.action || 'Processed';
        if (data.type === 'item_error' || data.type === 'fatal') {
          state.action = data.message || data.type;
          state.error = true;
        }
        if (data.type === 'complete' || data.type === 'fatal' || data.type === 'cancelled') {
          state.done = true;
          if (data.type === 'complete' && !state.error && state.action === 'Starting…') state.action = 'Completed';
          es.close();
        }
        render();
      };
      es.onerror = () => {
        const state = states.get(job.job_id);
        if (state && !state.done) {
          state.action = 'Live connection interrupted';
          state.error = true;
          render();
        }
      };
    });
  }

  async function loadRunDetail(card, run) {
    card.innerHTML = `<div class="section-head"><div><h2>Run #${run.id}</h2><p>Loading run details…</p></div></div>`;
    const [events, review] = await Promise.all([
      getJson(`/api/history/${run.id}/events?limit=10000`),
      getJson(`/api/history/${run.id}/candidates`),
    ]);
    const candidates = review.candidates || [];
    card.innerHTML = `
      <div class="section-head">
        <div><h2>Run #${run.id}</h2><p>Events are shown chronologically. Times are converted from UTC to <strong>${e(zone)}</strong>.</p></div>
        <span class="pill info">${events.length} EVENTS</span>
      </div>
      ${metaHtml(run)}
      <div class="event-list">${events.map(eventHtml).join('') || '<div class="empty-state">No events for this run.</div>'}</div>
      <div class="review-panel">
        <div class="section-head">
          <div><h2>NFO review</h2><p>Dry-run write candidates can be applied individually or all together. Only verified Scene candidates are offered.</p></div>
          <span class="pill info">${candidates.length} CANDIDATES</span>
        </div>
        ${run.mode === 'dry-run' && candidates.length ? `
          <div class="review-toolbar">
            <input class="field grow" id="review-search" placeholder="Search title or release…">
            <span class="summary-chip" id="review-selected-count">0 selected</span>
            <button class="btn secondary" id="review-select-visible">Select visible</button>
            <button class="btn secondary" id="review-clear">Clear</button>
            <button class="btn warning" id="review-apply-selected" disabled>Apply selected</button>
            <button class="btn danger" id="review-apply-all">Apply all ${candidates.length}</button>
          </div>
          <div class="run-hint">Apply writes NFO files. The selected item is revalidated against the configured sources before SceneNFO writes or replaces anything.</div>
          <div class="candidate-list" id="candidate-list">${candidates.map(candidateHtml).join('')}</div>
          <div class="apply-progress" id="review-apply-progress" style="display:none"></div>
        ` : `<div class="empty-state">${run.mode !== 'dry-run' ? 'This is not a Dry Run.' : 'This run has no NFO create/replace candidates.'}</div>`}
      </div>`;

    if (!(run.mode === 'dry-run' && candidates.length)) return;
    const list = card.querySelector('#candidate-list');
    const applySelected = card.querySelector('#review-apply-selected');
    const progress = card.querySelector('#review-apply-progress');
    bindCandidateCards(card);

    const syncButtons = () => {
      const count = card.querySelectorAll('.review-candidate:checked').length;
      applySelected.disabled = count === 0;
      updateSelectedCount(card);
    };
    card.querySelectorAll('.review-candidate').forEach(cb => cb.addEventListener('change', syncButtons));

    card.querySelector('#review-search').addEventListener('input', ev => {
      const q = ev.target.value.trim().toLowerCase();
      list.querySelectorAll('.candidate-row').forEach(row => {
        row.style.display = !q || row.dataset.search.includes(q) ? '' : 'none';
      });
    });
    card.querySelector('#review-select-visible').onclick = () => {
      list.querySelectorAll('.candidate-row').forEach(row => {
        if (row.style.display === 'none') return;
        const cb = row.querySelector('.review-candidate');
        cb.checked = true;
        row.classList.add('selected');
      });
      syncButtons();
    };
    card.querySelector('#review-clear').onclick = () => {
      list.querySelectorAll('.review-candidate').forEach(cb => {
        cb.checked = false;
        cb.closest('.candidate-row')?.classList.remove('selected');
      });
      syncButtons();
    };

    async function apply(body, label) {
      if (!confirm(`${label}? This will write NFO files.`)) return;
      progress.style.display = '';
      progress.textContent = 'Starting apply job(s)…';
      try {
        const result = await getJson(`/api/history/${run.id}/apply`, {method:'POST', body:JSON.stringify(body)});
        progress.textContent = `Started ${result.started} item${result.started === 1 ? '' : 's'}.`;
        monitorApplyJobs(result.jobs || [], progress);
      } catch (err) {
        progress.innerHTML = `<span class="apply-error">${e(err.message)}</span>`;
      }
    }

    applySelected.onclick = () => {
      const media_paths = [...card.querySelectorAll('.review-candidate:checked')].map(cb => cb.value);
      apply({media_paths, apply_all:false}, `Apply ${media_paths.length} selected NFO candidate${media_paths.length === 1 ? '' : 's'}`);
    };
    card.querySelector('#review-apply-all').onclick = () => apply({media_paths:[], apply_all:true}, `Apply all ${candidates.length} NFO candidates`);
  }

  async function mountLogs(card) {
    if (card.dataset.runReviewMounted === '1') return;
    card.dataset.runReviewMounted = '1';
    card.innerHTML = `<div class="section-head"><div><h2>Run logs</h2><p>Loading runs…</p></div></div>`;
    try {
      const runs = await getJson('/api/history?limit=250');
      if (!runs.length) {
        card.innerHTML = '<div class="empty-state">No runs recorded yet.</div>';
        return;
      }
      card.innerHTML = `
        <div class="run-log-shell">
          <div class="card section-card run-list-card">
            <div class="section-head"><div><h2>Runs</h2><p>Select a specific run instead of mixing all log entries.</p></div><span class="pill info">${runs.length}</span></div>
            <label class="stack-field"><span>Run</span><select class="run-select" id="run-log-select">${runs.map(r => `<option value="${r.id}">${e(runOption(r))}</option>`).join('')}</select></label>
            <p class="timezone-note">Displayed timezone: ${e(zone)}. Timestamps remain stored as UTC in SQLite.</p>
          </div>
          <div class="card section-card run-detail-card" id="run-detail"></div>
        </div>`;
      const select = card.querySelector('#run-log-select');
      const detail = card.querySelector('#run-detail');
      const byId = new Map(runs.map(r => [String(r.id), r]));
      const load = () => loadRunDetail(detail, byId.get(select.value)).catch(err => {
        detail.innerHTML = `<div class="empty-state apply-error">${e(err.message)}</div>`;
      });
      select.onchange = load;
      await load();
    } catch (err) {
      card.innerHTML = `<div class="empty-state apply-error">Failed to load runs: ${e(err.message)}</div>`;
    }
  }

  function enhance() {
    const logbox = document.querySelector('.logbox');
    const card = logbox?.closest('.section-card');
    if (card) mountLogs(card);
  }

  const observer = new MutationObserver(enhance);
  observer.observe(document.documentElement, {childList:true, subtree:true});
  document.addEventListener('DOMContentLoaded', enhance);
})();
