(() => {
  const nativeFetch = window.fetch.bind(window);
  const NativeEventSource = window.EventSource;

  window.__scenenfoScanScope = 'incremental';
  window.__scenenfoSchedules = new Map();
  window.__scenenfoInventory = {discovered: 0, queued: 0, skipped: 0, removed: 0};

  const resetInventory = () => {
    window.__scenenfoInventory = {discovered: 0, queued: 0, skipped: 0, removed: 0};
  };

  const scopeOptions = selected => `
    <option value="incremental" ${selected === 'incremental' ? 'selected' : ''}>New / changed only</option>
    <option value="full" ${selected === 'full' ? 'selected' : ''}>Full rescan</option>`;

  const normalizeUrl = input => {
    const raw = typeof input === 'string' ? input : input?.url;
    if (!raw) return input;
    const u = new URL(raw, location.origin);

    // Old cached app.js used library_id= for the "All libraries" option. FastAPI
    // correctly rejected that empty string as an integer. Omit empty filters.
    for (const key of ['library_id', 'classification', 'nfo', 'group', 'q']) {
      if (u.searchParams.get(key) === '') u.searchParams.delete(key);
    }

    if (/^https?:/i.test(raw)) return u.toString();
    return `${u.pathname}${u.search}${u.hash}`;
  };

  const jsonBody = init => {
    if (!init?.body || typeof init.body !== 'string') return null;
    try { return JSON.parse(init.body); } catch { return null; }
  };

  const selectedScheduleScope = url => {
    const match = url.match(/\/api\/schedules\/(\d+)/);
    if (match) {
      const row = document.querySelector(`.schedule-editor[data-schedule-id="${match[1]}"]`);
      return row?.querySelector('.sched-scope')?.value || 'incremental';
    }
    return document.querySelector('#new-sched-scope')?.value || 'incremental';
  };

  window.fetch = async (input, init = {}) => {
    const normalized = normalizeUrl(input);
    const url = typeof normalized === 'string' ? normalized : normalized?.url || '';
    const method = String(init.method || 'GET').toUpperCase();
    let nextInit = init;

    if (method === 'POST' && /\/api\/scans(?:\?|$)/.test(url)) {
      const body = jsonBody(init) || {};
      body.scan_scope = document.querySelector('#scan-scope')?.value
        || window.__scenenfoScanScope
        || 'incremental';
      window.__scenenfoScanScope = body.scan_scope;
      nextInit = {...init, body: JSON.stringify(body)};
    }

    if ((method === 'POST' || method === 'PUT') && /\/api\/schedules(?:\/\d+)?(?:\?|$)/.test(url)) {
      const body = jsonBody(init) || {};
      body.scan_scope = selectedScheduleScope(url);
      nextInit = {...init, body: JSON.stringify(body)};
    }

    const response = await nativeFetch(normalized, nextInit);

    if (method === 'GET' && /\/api\/schedules(?:\?|$)/.test(url) && response.ok) {
      response.clone().json().then(rows => {
        window.__scenenfoSchedules = new Map((rows || []).map(s => [String(s.id), s]));
        queueMicrotask(enhanceUi);
      }).catch(() => {});
    }

    return response;
  };

  if (NativeEventSource) {
    class SceneNFOEventSource extends NativeEventSource {
      constructor(url, options) {
        super(url, options);
        this.addEventListener('message', event => {
          let data;
          try { data = JSON.parse(event.data); } catch { return; }

          if (data.type === 'inventory') {
            const inv = window.__scenenfoInventory;
            inv.discovered += Number(data.discovered || 0);
            inv.queued += Number(data.queued ?? data.total ?? 0);
            inv.skipped += Number(data.skipped || 0);
            inv.removed += Number(data.removed || 0);
            const status = document.querySelector('#scan-status');
            if (status) {
              const scope = data.scan_scope === 'full' ? 'Full rescan' : 'New / changed only';
              status.textContent = `${scope} · ${inv.discovered} found · ${inv.queued} queued · ${inv.skipped} unchanged`;
            }
          }

          if (data.type === 'complete') {
            setTimeout(() => {
              const counts = document.querySelector('#scan-counts');
              if (!counts) return;
              const inv = window.__scenenfoInventory;
              const extra = `${inv.skipped} unchanged · ${inv.removed} removed`;
              if (!counts.textContent.includes('unchanged')) {
                counts.textContent = counts.textContent ? `${counts.textContent} · ${extra}` : extra;
              }
            }, 0);
          }
        });
      }
    }
    window.EventSource = SceneNFOEventSource;
  }

  const makeScopeField = (id, cls, selected = 'incremental') => {
    const label = document.createElement('label');
    label.className = 'stack-field scope-field';
    label.innerHTML = `<span>Scan scope</span><select ${id ? `id="${id}"` : ''} ${cls ? `class="${cls}"` : ''}>${scopeOptions(selected)}</select>`;
    const select = label.querySelector('select');
    select?.addEventListener('change', () => {
      if (id === 'dash-scope' || id === 'scan-scope') window.__scenenfoScanScope = select.value;
    });
    return label;
  };

  function enhanceDashboard() {
    const options = document.querySelector('.quick-run-options');
    if (!options || document.querySelector('#dash-scope')) return;
    const field = makeScopeField('dash-scope', '', window.__scenenfoScanScope || 'incremental');
    options.insertBefore(field, options.firstElementChild);

    const note = document.createElement('div');
    note.className = 'run-hint incremental-hint';
    note.textContent = 'New / changed only uses the SQLite inventory and skips unchanged MKVs without contacting PreDB.';
    options.appendChild(note);
  }

  function enhanceScan() {
    const grid = document.querySelector('.scan-options-grid');
    if (!grid || document.querySelector('#scan-scope')) return;
    grid.appendChild(makeScopeField('scan-scope', '', window.__scenenfoScanScope || 'incremental'));
    grid.style.gridTemplateColumns = 'repeat(3,minmax(0,1fr))';
  }

  function enhanceSchedules() {
    document.querySelectorAll('.schedule-editor').forEach(row => {
      if (row.querySelector('.sched-scope')) return;
      const id = String(row.dataset.scheduleId || '');
      const schedule = window.__scenenfoSchedules.get(id);
      const grid = row.querySelector('.schedule-head-grid');
      if (!grid) return;
      grid.appendChild(makeScopeField('', 'sched-scope', schedule?.scan_scope || 'incremental'));
      grid.style.gridTemplateColumns = '1.15fr .8fr .72fr .78fr .95fr 1.05fr';
    });

    const newCron = document.querySelector('#new-sched-cron');
    const newGrid = newCron?.closest('.schedule-head-grid');
    if (newGrid && !document.querySelector('#new-sched-scope')) {
      newGrid.appendChild(makeScopeField('new-sched-scope', '', 'incremental'));
      newGrid.style.gridTemplateColumns = '1.15fr .8fr .72fr .78fr .95fr 1.05fr';
    }
  }

  function enhanceHistory() {
    const table = document.querySelector('.table-wrap table');
    if (!table || !document.body.textContent.includes('Manual, scheduled and import-triggered activity.')) return;
    // The backend already stores scan_scope/skipped/removed. Keep the existing
    // compact table for now; details remain available through the run events.
  }

  function enhanceUi() {
    enhanceDashboard();
    enhanceScan();
    enhanceSchedules();
    enhanceHistory();
  }

  document.addEventListener('click', event => {
    const target = event.target.closest?.('button');
    if (!target) return;
    if (target.id === 'dash-run') {
      resetInventory();
      window.__scenenfoScanScope = document.querySelector('#dash-scope')?.value || 'incremental';
    }
    if (target.id === 'run-scan') {
      resetInventory();
      window.__scenenfoScanScope = document.querySelector('#scan-scope')?.value || 'incremental';
    }
  }, true);

  const observer = new MutationObserver(() => enhanceUi());
  observer.observe(document.documentElement, {childList: true, subtree: true});
  document.addEventListener('DOMContentLoaded', enhanceUi);
})();
