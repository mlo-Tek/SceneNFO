(() => {
  const e = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));

  const localDateTime = value => {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return new Intl.DateTimeFormat('de-DE', {
      year:'numeric', month:'2-digit', day:'2-digit',
      hour:'2-digit', minute:'2-digit', second:'2-digit'
    }).format(d);
  };

  const readable = value => String(value || '—').replaceAll('_', ' ');
  const policyShort = value => value === 'replace_all' ? 'Replace all' : value === 'missing_only' ? 'Missing only' : readable(value);
  const scopeShort = value => value === 'full' ? 'Full rescan' : 'New / changed only';
  const triggerShort = value => {
    const t = String(value || '');
    if (t === 'manual') return 'Manual';
    if (t === 'radarr-import') return 'Radarr import';
    if (t === 'sonarr-import-complete') return 'Sonarr import';
    if (t.startsWith('schedule:')) return `Schedule · ${t.slice(9)}`;
    if (t.startsWith('review-apply:')) return `Review apply · #${t.slice(13)}`;
    return t || 'Unknown';
  };

  function compactScanSummary(){
    const summary = document.querySelector('#scan-compact-summary');
    if (!summary) return;
    const selected = document.querySelectorAll('.scan-lib:checked').length;
    const mode = document.querySelector('#scan-mode')?.value === 'true' ? 'Apply' : 'Dry Run';
    const policy = document.querySelector('#scan-policy')?.value === 'replace_all' ? 'Replace all' : 'Missing only';
    const scope = document.querySelector('#scan-scope')?.value === 'full' ? 'Full rescan' : 'New / changed only';
    summary.innerHTML = `
      <span class="scan-summary-item"><strong>${selected}</strong> ${selected === 1 ? 'library' : 'libraries'}</span>
      <span class="scan-summary-item">${e(mode)}</span>
      <span class="scan-summary-item">${e(policy)}</span>
      <span class="scan-summary-item">${e(scope)}</span>`;
  }

  function setScanConfigCollapsed(collapsed){
    const layout = document.querySelector('.scan-layout');
    const controls = document.querySelector('.scan-controls');
    const button = document.querySelector('#scan-config-toggle');
    if (!layout || !controls) return;
    layout.classList.toggle('scan-config-collapsed', collapsed);
    controls.classList.toggle('scan-config-collapsed', collapsed);
    if (button) {
      button.innerHTML = collapsed ? '<span aria-hidden="true">⌄</span> Expand' : '<span aria-hidden="true">⌃</span> Collapse';
      button.title = collapsed ? 'Expand run configuration' : 'Collapse run configuration';
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
    compactScanSummary();
  }

  function enhanceScanWorkspace(){
    const layout = document.querySelector('.scan-layout');
    const controls = document.querySelector('.scan-controls');
    if (!layout || !controls || controls.dataset.workspaceEnhanced === '1') return;
    controls.dataset.workspaceEnhanced = '1';

    const head = controls.querySelector('.section-head');
    if (head) {
      const toggle = document.createElement('button');
      toggle.id = 'scan-config-toggle';
      toggle.className = 'btn secondary scan-config-toggle';
      toggle.type = 'button';
      toggle.innerHTML = '<span aria-hidden="true">⌃</span> Collapse';
      toggle.title = 'Collapse run configuration';
      toggle.setAttribute('aria-label', toggle.title);
      toggle.setAttribute('aria-expanded', 'true');
      head.appendChild(toggle);
      toggle.addEventListener('click', () => {
        setScanConfigCollapsed(!controls.classList.contains('scan-config-collapsed'));
      });
    }

    const summary = document.createElement('div');
    summary.id = 'scan-compact-summary';
    summary.className = 'scan-compact-summary';
    const actions = controls.querySelector('.scan-actions');
    controls.insertBefore(summary, actions || controls.firstChild);

    controls.addEventListener('change', event => {
      if (event.target.matches('.scan-lib,#scan-mode,#scan-policy,#scan-scope')) compactScanSummary();
    });

    compactScanSummary();
  }

  const originalRenderScan = typeof renderScan === 'function' ? renderScan : null;
  if (originalRenderScan) {
    renderScan = async function(...args){
      const result = await originalRenderScan(...args);
      enhanceScanWorkspace();
      setTimeout(() => compactScanSummary(), 30);
      return result;
    };
  }

  const originalStartSelectedLibraries = typeof startSelectedLibraries === 'function' ? startSelectedLibraries : null;
  if (originalStartSelectedLibraries) {
    startSelectedLibraries = async function(...args){
      const selected = document.querySelectorAll('.scan-lib:checked').length;
      if (selected) setScanConfigCollapsed(true);
      return originalStartSelectedLibraries(...args);
    };
  }

  if (typeof renderLiveRows === 'function') {
    renderLiveRows = function(){
      const list = document.querySelector('#live-list');
      if (!list) return;
      if (!liveRows.length) {
        list.innerHTML = '<div class="empty-state">No scan results yet.</div>';
        return;
      }
      list.innerHTML = liveRows.map(row => {
        const classification = String(row.classification || '').toLowerCase();
        const isError = String(row.action || '').toUpperCase() === 'ERROR' || row.type === 'item_error';
        const action = readable(row.action || (isError ? 'ERROR' : ''));
        const actionClass = isError ? 'error' : /CREATE|REPLACE|WRITE|DOWNLOAD/i.test(action) ? 'write' : '';
        const typeClass = isError ? 'error' : classification === 'scene' ? 'scene' : classification === 'p2p' ? 'p2p' : '';
        const classPill = classification ? pill(classification) : '';
        const progress = row.total ? `${Number(row.index || 0)}/${Number(row.total)}` : (row.index || '');
        return `<article class="live-result-row ${typeClass}">
          <div class="live-result-top">
            <span class="live-result-library">${e(row.library_name || '')}</span>
            ${progress ? `<span class="live-result-index">${e(progress)}</span>` : ''}
            ${classPill}
            ${action ? `<span class="live-result-action ${actionClass}">${e(action)}</span>` : ''}
          </div>
          <div class="live-result-release">${e(row.release || row.message || '')}</div>
        </article>`;
      }).join('');
    };
  }

  async function openHistoryRunInLogs(id){
    await navigate('logs');
    for (let i = 0; i < 40; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const select = document.querySelector('#run-log-select');
      if (!select) continue;
      if ([...select.options].some(option => option.value === String(id))) {
        select.value = String(id);
        select.dispatchEvent(new Event('change', {bubbles:true}));
      }
      return;
    }
  }

  if (typeof renderHistory === 'function') {
    renderHistory = async function(){
      const rows = await api('/api/history?limit=250');
      content.innerHTML = `<div class="card section-card history-page-card">
        <div class="section-head">
          <div><h2>Runs</h2><p>Recent manual, scheduled and import runs. Open any run directly in Logs for full events and NFO review.</p></div>
          <span class="pill info">${rows.length} RUNS</span>
        </div>
        <div class="history-run-grid">${rows.map(run => {
          const statusClass = String(run.status || '').toLowerCase();
          const mode = run.mode === 'apply' ? 'Apply' : run.mode === 'dry-run' ? 'Dry Run' : readable(run.mode);
          return `<article class="history-run-card">
            <div class="history-run-head">
              <div><div class="history-run-id">Run #${Number(run.id)}</div><div class="history-run-time">${e(localDateTime(run.started_at))}</div></div>
              <span class="history-status ${e(statusClass)}">${e(readable(run.status))}</span>
            </div>
            <div class="history-run-library">${e(run.library_name || run.library || 'Unknown library')}</div>
            <div class="history-run-tags">
              <span class="summary-chip">${e(triggerShort(run.trigger))}</span>
              <span class="summary-chip">${e(mode)}</span>
              <span class="summary-chip">${e(scopeShort(run.scan_scope))}</span>
              <span class="summary-chip">${e(policyShort(run.nfo_policy))}</span>
            </div>
            <div class="history-metrics">
              <div class="history-metric"><span>Scanned</span><strong>${Number(run.scanned || 0)}</strong></div>
              <div class="history-metric"><span>Scene</span><strong>${Number(run.scene || 0)}</strong></div>
              <div class="history-metric"><span>P2P</span><strong>${Number(run.p2p || 0)}</strong></div>
              <div class="history-metric"><span>Errors</span><strong>${Number(run.errors || 0)}</strong></div>
            </div>
            <div class="history-run-actions"><button class="btn secondary history-open-log" data-run-id="${Number(run.id)}">Open in Logs</button></div>
          </article>`;
        }).join('') || '<div class="empty-state">No runs recorded yet.</div>'}</div>
      </div>`;

      content.querySelectorAll('.history-open-log').forEach(button => {
        button.addEventListener('click', () => openHistoryRunInLogs(Number(button.dataset.runId)));
      });
    };
  }

  document.addEventListener('click', event => {
    const nav = event.target.closest?.('.nav[data-view="scan"]');
    if (nav) setTimeout(enhanceScanWorkspace, 0);
  });
})();
