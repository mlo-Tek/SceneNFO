(() => {
  const STATE_KEY = 'scenenfo-log-workspace';

  const readState = () => {
    try {
      return {...{order:'newest', type:'all', errors:false, q:''}, ...JSON.parse(localStorage.getItem(STATE_KEY) || '{}')};
    } catch {
      return {order:'newest', type:'all', errors:false, q:''};
    }
  };

  const writeState = state => {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch {}
  };

  const downloadText = (name, text) => {
    const blob = new Blob([text], {type:'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const rowKind = row => row.querySelector('.event-kind')?.textContent.trim() || '';
  const rowLevel = row => row.querySelector('.event-level')?.textContent.trim().toLowerCase() || '';

  function applyFilters(detail, state){
    const list = detail.querySelector('.event-list');
    if (!list) return;
    const q = state.q.trim().toLowerCase();
    let visible = 0;
    list.querySelectorAll('.event-row').forEach(row => {
      const kind = rowKind(row);
      const isError = rowLevel(row) === 'error' || /error|fatal/i.test(kind);
      const show = (state.type === 'all' || kind === state.type)
        && (!state.errors || isError)
        && (!q || row.textContent.toLowerCase().includes(q));
      row.hidden = !show;
      if (show) visible += 1;
    });
    const count = detail.querySelector('#log-visible-count');
    if (count) count.textContent = `${visible} visible`;
  }

  function setOrder(detail, state, force=false){
    const list = detail.querySelector('.event-list');
    if (!list) return;
    const current = list.dataset.order || 'oldest';
    if (!force && current === state.order) return;
    const rows = [...list.querySelectorAll('.event-row')];
    rows.reverse().forEach(row => list.appendChild(row));
    list.dataset.order = state.order;
  }

  function exportRun(detail){
    const title = detail.querySelector('.section-head h2')?.textContent.trim() || 'SceneNFO run';
    const runNumber = title.match(/#(\d+)/)?.[1] || 'run';
    const meta = [...detail.querySelectorAll('.run-meta-item')].map(item => {
      const key = item.querySelector('span')?.textContent.trim() || '';
      const value = item.querySelector('strong')?.textContent.trim() || '';
      return `${key}: ${value}`;
    });
    const summary = [...detail.querySelectorAll('.run-summary .summary-chip')].map(x => x.textContent.trim()).join(' | ');
    const rows = [...detail.querySelectorAll('.event-list .event-row')].map(row => {
      const cols = [...row.children].map(x => x.textContent.trim().replace(/\s+/g, ' '));
      return cols.join(' | ');
    });
    const text = [
      'SceneNFO run log',
      title,
      ...meta,
      summary,
      '',
      'Displayed order: ' + (detail.querySelector('#log-order')?.value === 'oldest' ? 'oldest first' : 'newest first'),
      'DATE / TIME | LEVEL | EVENT | MESSAGE',
      ...rows,
      '',
    ].join('\n');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadText(`SceneNFO-run-${runNumber}-${stamp}.log`, text);
  }

  function enhanceDetail(detail){
    const list = detail.querySelector('.event-list');
    if (!list || list.dataset.workspaceReady === '1') return;
    list.dataset.workspaceReady = '1';

    const state = readState();
    // run-review-ui renders oldest first. Mark that source order before applying the saved preference.
    list.dataset.order = 'oldest';

    const headCopy = detail.querySelector('.section-head p');
    if (headCopy) headCopy.innerHTML = `Newest events are shown first by default. Times are displayed in <strong>${Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'}</strong>.`;

    const kinds = [...new Set([...list.querySelectorAll('.event-kind')].map(x => x.textContent.trim()).filter(Boolean))].sort((a,b) => a.localeCompare(b));
    const toolbar = document.createElement('div');
    toolbar.className = 'log-toolbar';
    toolbar.innerHTML = `
      <label class="stack-field log-search-field"><span>Search log</span><input id="log-search" class="field" type="search" placeholder="Search event, release, group or message…" value="${String(state.q || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"></label>
      <label class="stack-field"><span>Event type</span><select id="log-event-type"><option value="all">All events</option>${kinds.map(kind => `<option value="${kind.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">${kind}</option>`).join('')}</select></label>
      <label class="stack-field"><span>Order</span><select id="log-order"><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
      <label class="log-error-toggle"><input id="log-errors-only" type="checkbox"><span>Errors only</span></label>
      <span class="summary-chip log-visible-count" id="log-visible-count"></span>
      <button class="btn secondary log-export" id="log-export" type="button">Export run log</button>`;
    list.parentNode.insertBefore(toolbar, list);

    const search = toolbar.querySelector('#log-search');
    const type = toolbar.querySelector('#log-event-type');
    const order = toolbar.querySelector('#log-order');
    const errors = toolbar.querySelector('#log-errors-only');
    type.value = kinds.includes(state.type) ? state.type : 'all';
    order.value = state.order === 'oldest' ? 'oldest' : 'newest';
    errors.checked = Boolean(state.errors);

    const sync = () => {
      const next = {
        q: search.value,
        type: type.value,
        order: order.value,
        errors: errors.checked,
      };
      writeState(next);
      setOrder(detail, next);
      applyFilters(detail, next);
    };

    let searchTimer;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(sync, 120);
    });
    type.addEventListener('change', sync);
    order.addEventListener('change', sync);
    errors.addEventListener('change', sync);
    toolbar.querySelector('#log-export').addEventListener('click', () => exportRun(detail));

    setOrder(detail, {...state, order:order.value});
    applyFilters(detail, {...state, type:type.value, order:order.value, errors:errors.checked, q:search.value});
  }

  function enhanceReview(detail){
    const review = detail.querySelector('.review-panel');
    if (!review || review.dataset.workspaceReady === '1') return;
    review.dataset.workspaceReady = '1';
    const search = review.querySelector('#review-search');
    if (search) search.placeholder = 'Search NFO candidates…';
  }

  function enhanceRunSelector(){
    const select = document.querySelector('#run-log-select');
    if (select) select.classList.add('unified-select');
  }

  function enhance(){
    enhanceRunSelector();
    const detail = document.querySelector('#run-detail');
    if (!detail) return;
    enhanceDetail(detail);
    enhanceReview(detail);
  }

  const observer = new MutationObserver(mutations => {
    if (!mutations.some(m => [...m.addedNodes].some(node => node.nodeType === 1))) return;
    requestAnimationFrame(enhance);
  });
  observer.observe(document.documentElement, {childList:true, subtree:true});
  document.addEventListener('DOMContentLoaded', enhance);
})();
