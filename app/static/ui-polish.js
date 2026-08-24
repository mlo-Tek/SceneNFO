(() => {
  const previousFetch = window.fetch.bind(window);
  const inventories = {movies: [], tv: []};
  const itemDetails = new Map();
  const libraryRenderTokens = {movies: 0, tv: 0};
  let lastBrowserDownload = null;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'
  }[ch]));

  const sourceLabel = source => ({
    srrdb: 'srrDB',
    predb: 'PreDB.club',
    crowdnfo: 'crowdNFO',
  }[String(source || '').toLowerCase()] || String(source || ''));

  const downloadedFrom = source => source ? `Downloaded from ${sourceLabel(source)}` : '';

  const localTime = value => {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('de-DE', {
      dateStyle:'short', timeStyle:'short'
    }).format(d);
  };

  function activeKind() {
    const view = document.querySelector('.nav.active')?.dataset?.view;
    return view === 'movies' || view === 'tv' ? view : null;
  }

  function sourceCellHtml(item) {
    const installed = item.nfo_source ? sourceLabel(item.nfo_source) : '';
    const browser = item.browser_nfo_source ? sourceLabel(item.browser_nfo_source) : '';
    const installedText = installed
      ? `<span class="source-installed">Downloaded from ${esc(installed)}</span>`
      : item.nfo_present
        ? '<span class="source-unknown">Source unknown</span>'
        : '<span class="source-none">No NFO installed</span>';
    const browserText = browser
      ? `<span class="source-browser">Browser only · Downloaded from ${esc(browser)}${item.browser_nfo_downloaded_at ? ` · ${esc(localTime(item.browser_nfo_downloaded_at))}` : ''}</span>`
      : '';
    return `<div class="nfo-source-stack">${installedText}${browserText}</div>`;
  }

  function enhanceLibrarySources(kind) {
    if (activeKind() !== kind) return false;
    const table = document.querySelector('#lib-table table');
    if (!table) return false;
    const rows = inventories[kind] || [];
    const trs = table.querySelectorAll('tbody tr');
    if (trs.length !== rows.length) return false;

    const headers = table.querySelectorAll('thead th');
    if (headers[5] && headers[5].textContent !== 'NFO Source') headers[5].textContent = 'NFO Source';

    for (let index = 0; index < trs.length; index += 1) {
      const item = rows[index];
      const cell = trs[index].children[5];
      if (!item || !cell) continue;
      const key = [
        item.nfo_source || '',
        item.browser_nfo_source || '',
        item.browser_nfo_downloaded_at || '',
        Number(item.nfo_present || 0),
      ].join('|');
      if (cell.dataset.scenenfoSourceKey === key) continue;
      const html = sourceCellHtml(item);
      if (cell.innerHTML !== html) cell.innerHTML = html;
      cell.dataset.scenenfoSourceKey = key;
    }
    return true;
  }

  function scheduleLibrarySourceEnhancement(kind) {
    const token = ++libraryRenderTokens[kind];
    let attempt = 0;
    const run = () => {
      if (token !== libraryRenderTokens[kind] || activeKind() !== kind) return;
      if (enhanceLibrarySources(kind)) return;
      attempt += 1;
      if (attempt < 12) setTimeout(() => requestAnimationFrame(run), attempt < 4 ? 0 : 25);
    };
    requestAnimationFrame(run);
  }

  window.fetch = async (input, init={}) => {
    const response = await previousFetch(input, init);
    const raw = typeof input === 'string' ? input : input?.url || '';
    const url = new URL(raw, location.origin);
    const method = String(init.method || 'GET').toUpperCase();

    const libraryMatch = url.pathname.match(/^\/api\/library\/(movies|tv)$/);
    if (libraryMatch && method === 'GET' && response.ok) {
      response.clone().json().then(rows => {
        const kind = libraryMatch[1];
        inventories[kind] = rows || [];
        scheduleLibrarySourceEnhancement(kind);
      }).catch(() => {});
    }

    const itemMatch = url.pathname.match(/^\/api\/items\/(\d+)$/);
    if (itemMatch && method === 'GET' && response.ok) {
      response.clone().json().then(item => {
        itemDetails.set(Number(itemMatch[1]), item);
        setTimeout(enhanceItemManager, 0);
      }).catch(() => {});
    }

    const sourceDownloadMatch = url.pathname.match(/^\/api\/items\/(\d+)\/nfo\/source-download$/);
    if (sourceDownloadMatch && response.ok) {
      const itemId = Number(sourceDownloadMatch[1]);
      const source = response.headers.get('X-SceneNFO-Source-Label')
        || sourceLabel(response.headers.get('X-SceneNFO-Source'))
        || 'Unknown';
      lastBrowserDownload = {itemId, source};
      const cached = itemDetails.get(itemId);
      if (cached) {
        cached.browser_nfo_source = response.headers.get('X-SceneNFO-Source') || source;
        cached.browser_nfo_downloaded_at = new Date().toISOString();
      }
      setTimeout(() => {
        const status = document.querySelector('#item-operation-status');
        if (status) {
          const text = `Browser download complete · Downloaded from ${source} · No files were written to or changed in the media folder.`;
          if (status.textContent !== text) status.textContent = text;
          status.className = 'item-operation-status ok';
        }
        enhanceItemManager();
        document.querySelector('#lib-filter')?.click();
      }, 120);
    }

    return response;
  };

  function renameTvIn(root) {
    if (!root) return;
    const rewrite = node => {
      const text = node.nodeValue || '';
      if (!text.includes('TV Shows') && !text.includes('TV Episodes') && !text.includes('TV episode inventory')) return;
      node.nodeValue = text
        .replaceAll('TV Shows', 'TV')
        .replaceAll('TV Episodes', 'TV')
        .replaceAll('TV episode inventory', 'TV library inventory');
    };

    if (root.nodeType === Node.TEXT_NODE) {
      rewrite(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) rewrite(walker.currentNode);
  }

  function setupSidebarToggle() {
    const shell = document.querySelector('.app-shell');
    const sidebar = document.querySelector('.sidebar');
    if (!shell || !sidebar) return;

    document.querySelectorAll('.sidebar .nav').forEach(button => {
      const label = button.querySelector('span')?.textContent?.trim();
      if (label && !button.title) button.title = label;
    });

    let button = sidebar.querySelector('.sidebar-toggle');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'sidebar-toggle';
      sidebar.appendChild(button);
    }

    const apply = collapsed => {
      shell.classList.toggle('sidebar-collapsed', collapsed);
      const symbol = collapsed ? '›' : '‹';
      const title = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
      if (button.textContent !== symbol) button.textContent = symbol;
      if (button.title !== title) button.title = title;
      button.setAttribute('aria-label', title);
      localStorage.setItem('scenenfo-sidebar-collapsed', collapsed ? '1' : '0');
    };

    if (!button.dataset.bound) {
      button.dataset.bound = '1';
      button.addEventListener('click', () => apply(!shell.classList.contains('sidebar-collapsed')));
    }
    apply(localStorage.getItem('scenenfo-sidebar-collapsed') === '1');
  }

  function enhanceCandidateStateElement(state) {
    if (!state || state.dataset.scenenfoNfoState === '1') return;
    const text = state.textContent.trim().toLowerCase();
    if (!text.includes('nfo present') && !text.includes('nfo missing')) return;
    state.dataset.scenenfoNfoState = '1';
    state.classList.add('candidate-nfo-state');
    state.classList.toggle('nfo-present', text.includes('present'));
    state.classList.toggle('nfo-missing', text.includes('missing'));
  }

  function enhanceCandidateStatesIn(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches?.('.candidate-row > .candidate-action:last-child')) enhanceCandidateStateElement(root);
    root.querySelectorAll?.('.candidate-row > .candidate-action:last-child').forEach(enhanceCandidateStateElement);
  }

  function enhanceItemManager() {
    const panel = document.querySelector('.item-manager');
    if (!panel) return;

    const download = panel.querySelector('.item-download-source');
    if (download) {
      if (download.textContent !== 'Download NFO to browser') download.textContent = 'Download NFO to browser';
      download.title = 'Downloads a copy to this browser only. The media folder is not changed.';
    }

    const actionBox = panel.querySelector('.item-actions');
    if (actionBox && download && !panel.querySelector('.browser-download-notice')) {
      const notice = document.createElement('div');
      notice.className = 'browser-download-notice';
      notice.innerHTML = '<strong>Browser download only</strong><span>This saves a fresh NFO copy to your current browser. It does not create, replace or delete any file in the media folder.</span>';
      actionBox.insertAdjacentElement('afterend', notice);
    }

    const itemId = Number(panel.querySelector('[data-item-id]')?.dataset?.itemId || 0);
    const item = itemDetails.get(itemId);
    const metaGrid = panel.querySelector('.item-meta-grid');
    const sourceMeta = [...panel.querySelectorAll('.item-meta')].find(el => {
      const label = el.querySelector('span')?.textContent.trim();
      return label === 'NFO source' || label === 'NFO Source' || label === 'Media-folder NFO source';
    });
    if (sourceMeta) {
      const label = sourceMeta.querySelector('span');
      if (label && label.textContent !== 'NFO Source') label.textContent = 'NFO Source';
      const strong = sourceMeta.querySelector('strong');
      if (strong && item) {
        const next = item.nfo_source
          ? downloadedFrom(item.nfo_source)
          : item.nfo_present ? 'Source unknown' : 'No NFO installed';
        if (strong.textContent !== next) strong.textContent = next;
      }
    }

    if (item && metaGrid && !metaGrid.querySelector('.browser-source-meta')) {
      const meta = document.createElement('div');
      meta.className = 'item-meta browser-source-meta';
      meta.innerHTML = `<span>Last browser-only download</span><strong>${item.browser_nfo_source ? `${esc(downloadedFrom(item.browser_nfo_source))}${item.browser_nfo_downloaded_at ? ` · ${esc(localTime(item.browser_nfo_downloaded_at))}` : ''}` : 'None'}</strong>`;
      metaGrid.appendChild(meta);
    } else if (item && metaGrid) {
      const strong = metaGrid.querySelector('.browser-source-meta strong');
      if (strong) {
        const next = item.browser_nfo_source
          ? `${downloadedFrom(item.browser_nfo_source)}${item.browser_nfo_downloaded_at ? ` · ${localTime(item.browser_nfo_downloaded_at)}` : ''}`
          : 'None';
        if (strong.textContent !== next) strong.textContent = next;
      }
    }

    if (lastBrowserDownload && lastBrowserDownload.itemId === itemId) {
      const status = panel.querySelector('#item-operation-status');
      if (status && !status.textContent.includes('No files were written')) {
        status.textContent = `Last browser download · Downloaded from ${lastBrowserDownload.source} · No media-folder files were changed.`;
      }
    }
  }

  function handleAddedNodes(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        renameTvIn(node);
        enhanceCandidateStatesIn(node);
      }
    }
  }

  setupSidebarToggle();
  renameTvIn(document.body);
  enhanceCandidateStatesIn(document.body);

  const contentRoot = document.querySelector('#content');
  if (contentRoot) {
    const observer = new MutationObserver(handleAddedNodes);
    observer.observe(contentRoot, {childList:true, subtree:true});
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupSidebarToggle();
    renameTvIn(document.body);
    enhanceCandidateStatesIn(document.body);
  });
})();
