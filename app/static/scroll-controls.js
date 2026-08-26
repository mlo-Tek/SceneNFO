(() => {
  const STORAGE_KEY = 'scenenfo-scroll-modes-v1';
  const DEFAULTS = {live:'auto', logs:'manual', history:'manual', review:'manual'};
  let state = {};
  let historyObserver = null;
  let logsObserver = null;

  try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { state = {}; }

  const getMode = key => state[key] === 'auto' || state[key] === 'manual' ? state[key] : (DEFAULTS[key] || 'manual');
  const save = () => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  };

  function refreshControls(key) {
    document.querySelectorAll(`.scroll-mode-control[data-scroll-key="${key}"]`).forEach(control => {
      const mode = getMode(key);
      control.querySelectorAll('[data-scroll-mode]').forEach(button => {
        const active = button.dataset.scrollMode === mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      control.dataset.mode = mode;
    });
  }

  function setMode(key, mode, snap=true) {
    if (mode !== 'auto' && mode !== 'manual') return;
    state[key] = mode;
    save();
    refreshControls(key);
    if (mode === 'auto' && snap) requestAnimationFrame(() => snapKey(key));
  }

  function mountControl(host, key, label='Scroll') {
    if (!host) return null;
    let control = host.querySelector(`.scroll-mode-control[data-scroll-key="${key}"]`);
    if (!control) {
      control = document.createElement('div');
      control.className = 'scroll-mode-control';
      control.dataset.scrollKey = key;
      control.innerHTML = `<span class="scroll-mode-label">${label}</span><div class="scroll-mode-segment" role="group" aria-label="${label} mode"><button type="button" data-scroll-mode="auto">Auto</button><button type="button" data-scroll-mode="manual">Manual</button></div>`;
      const trailingPill = [...host.children].find(node => node.classList?.contains('pill'));
      if (host.classList.contains('section-head') && trailingPill) host.insertBefore(control, trailingPill);
      else host.appendChild(control);
      control.addEventListener('click', event => {
        const button = event.target.closest('[data-scroll-mode]');
        if (!button) return;
        setMode(key, button.dataset.scrollMode);
      });
    }
    refreshControls(key);
    return control;
  }

  function markManualOnUserScroll(scroller, key) {
    if (!scroller || scroller.dataset.scrollModeBound === key) return;
    scroller.dataset.scrollModeBound = key;
    const manual = () => {
      if (getMode(key) === 'auto') setMode(key, 'manual', false);
    };
    scroller.addEventListener('wheel', manual, {passive:true});
    scroller.addEventListener('touchstart', manual, {passive:true});
  }

  function snapKey(key) {
    if (key === 'live') {
      const list = document.querySelector('#live-list');
      if (list) list.scrollTop = 0;
      return;
    }
    if (key === 'history') {
      const list = document.querySelector('#history-list-area .history-list');
      if (list) list.scrollTop = 0;
      return;
    }
    if (key === 'logs') {
      const list = document.querySelector('#perf-log-events');
      if (!list) return;
      const order = document.querySelector('#perf-log-order')?.value || 'desc';
      list.scrollTop = order === 'asc' ? list.scrollHeight : 0;
      return;
    }
    if (key === 'review') {
      const list = document.querySelector('#perf-review-list');
      if (list) list.scrollTop = 0;
    }
  }

  function liveAnchor(list) {
    if (!list) return null;
    const top = list.scrollTop;
    const rows = [...list.querySelectorAll('.live-result-row')];
    const row = rows.find(item => item.offsetTop + item.offsetHeight > top) || rows[0] || null;
    return {
      top,
      height:list.scrollHeight,
      release:row?.querySelector('.live-result-release')?.textContent || '',
      delta:row ? row.offsetTop - top : 0,
    };
  }

  function restoreLiveAnchor(list, before) {
    if (!list || !before) return;
    if (before.release) {
      const row = [...list.querySelectorAll('.live-result-row')].find(item => item.querySelector('.live-result-release')?.textContent === before.release);
      if (row) {
        list.scrollTop = Math.max(0, row.offsetTop - before.delta);
        return;
      }
    }
    const growth = Math.max(0, list.scrollHeight - before.height);
    list.scrollTop = Math.max(0, before.top + growth);
  }

  function enhanceLive() {
    const card = document.querySelector('.live-results-card');
    const list = document.querySelector('#live-list');
    if (!card || !list) return;
    mountControl(card.querySelector('.section-head'), 'live');
    markManualOnUserScroll(list, 'live');
  }

  function enhanceHistoryList() {
    const card = document.querySelector('.history-performance-card');
    const list = document.querySelector('#history-list-area .history-list');
    if (!card || !list) return;
    list.classList.add('scroll-mode-history-list');
    mountControl(card.querySelector('.section-head'), 'history');
    markManualOnUserScroll(list, 'history');
    if (getMode('history') === 'auto') list.scrollTop = 0;
  }

  function enhanceLogsLists() {
    const events = document.querySelector('#perf-log-events');
    if (events) {
      mountControl(document.querySelector('.logs-toolbar-v2'), 'logs');
      markManualOnUserScroll(events, 'logs');
      if (getMode('logs') === 'auto') snapKey('logs');
    }

    const review = document.querySelector('#perf-review-list');
    if (review) {
      mountControl(document.querySelector('.logs-review-actions'), 'review');
      markManualOnUserScroll(review, 'review');
      if (getMode('review') === 'auto') review.scrollTop = 0;
    }
  }

  function cleanupObservers() {
    historyObserver?.disconnect();
    logsObserver?.disconnect();
    historyObserver = null;
    logsObserver = null;
  }

  const originalNavigate = typeof navigate === 'function' ? navigate : null;
  if (originalNavigate) {
    navigate = async function(...args) {
      cleanupObservers();
      return originalNavigate(...args);
    };
  }

  const originalRenderLiveRows = typeof renderLiveRows === 'function' ? renderLiveRows : null;
  if (originalRenderLiveRows) {
    renderLiveRows = function(...args) {
      const beforeList = document.querySelector('#live-list');
      const before = liveAnchor(beforeList);
      const mode = getMode('live');
      const result = originalRenderLiveRows(...args);
      enhanceLive();
      const list = document.querySelector('#live-list');
      if (list) requestAnimationFrame(() => {
        if (mode === 'auto') list.scrollTop = 0;
        else restoreLiveAnchor(list, before);
      });
      return result;
    };
  }

  const originalRenderScan = typeof renderScan === 'function' ? renderScan : null;
  if (originalRenderScan) {
    renderScan = async function(...args) {
      const result = await originalRenderScan(...args);
      enhanceLive();
      return result;
    };
  }

  const originalRenderHistory = typeof renderHistory === 'function' ? renderHistory : null;
  if (originalRenderHistory) {
    renderHistory = async function(...args) {
      historyObserver?.disconnect();
      const result = await originalRenderHistory(...args);
      const area = document.querySelector('#history-list-area');
      if (area) {
        enhanceHistoryList();
        historyObserver = new MutationObserver(() => requestAnimationFrame(enhanceHistoryList));
        historyObserver.observe(area, {childList:true, subtree:false});
      }
      return result;
    };
  }

  const originalRenderLogs = typeof renderLogs === 'function' ? renderLogs : null;
  if (originalRenderLogs) {
    renderLogs = async function(...args) {
      logsObserver?.disconnect();
      const result = await originalRenderLogs(...args);
      const root = document.querySelector('#logs-performance-root');
      if (root) {
        enhanceLogsLists();
        logsObserver = new MutationObserver(() => requestAnimationFrame(enhanceLogsLists));
        logsObserver.observe(root, {childList:true, subtree:true});
      }
      return result;
    };
  }

  document.addEventListener('change', event => {
    if (event.target?.id === 'perf-log-order' && getMode('logs') === 'auto') {
      setTimeout(() => snapKey('logs'), 80);
    }
  });

  enhanceLive();
})();
