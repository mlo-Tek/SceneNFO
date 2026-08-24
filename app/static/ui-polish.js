(() => {
  const previousFetch = window.fetch.bind(window);
  const inventories = {movies: [], tv: []};
  const itemDetails = new Map();
  let lastBrowserDownload = null;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
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

  window.fetch = async (input, init={}) => {
    const response = await previousFetch(input, init);
    const raw = typeof input === 'string' ? input : input?.url || '';
    const url = new URL(raw, location.origin);
    const method = String(init.method || 'GET').toUpperCase();

    const libraryMatch = url.pathname.match(/^\/api\/library\/(movies|tv)$/);
    if (libraryMatch && method === 'GET' && response.ok) {
      response.clone().json().then(rows => {
        inventories[libraryMatch[1]] = rows || [];
        setTimeout(enhanceLibrarySources, 0);
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
          status.textContent = `Browser download complete · Downloaded from ${source} · No files were written to or changed in the media folder.`;
          status.className = 'item-operation-status ok';
        }
        enhanceItemManager();
        document.querySelector('#lib-filter')?.click();
      }, 120);
    }

    return response;
  };

  function renameTvEverywhere(root=document.body) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      let text = node.nodeValue || '';
      const next = text
        .replaceAll('TV Shows', 'TV')
        .replaceAll('TV Episodes', 'TV')
        .replaceAll('TV episode inventory', 'TV library inventory');
      if (next !== text) node.nodeValue = next;
    }
  }

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

  function enhanceLibrarySources() {
    const kind = activeKind();
    const table = document.querySelector('#lib-table table');
    if (!kind || !table) return;
    const rows = inventories[kind] || [];
    const trs = [...table.querySelectorAll('tbody tr')];
    if (!rows.length || rows.length !== trs.length) return;

    const headers = [...table.querySelectorAll('thead th')];
    if (headers[5]) headers[5].textContent = 'NFO Source';

    trs.forEach((tr, index) => {
      const cells = tr.querySelectorAll('td');
      if (cells[5] && rows[index]) cells[5].innerHTML = sourceCellHtml(rows[index]);
    });
  }

  function enhanceItemManager() {
    const panel = document.querySelector('.item-manager');
    if (!panel) return;

    const download = panel.querySelector('.item-download-source');
    if (download) {
      download.textContent = 'Download NFO to browser';
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
      sourceMeta.querySelector('span').textContent = 'NFO Source';
      const strong = sourceMeta.querySelector('strong');
      if (strong && item) {
        strong.textContent = item.nfo_source
          ? downloadedFrom(item.nfo_source)
          : item.nfo_present ? 'Source unknown' : 'No NFO installed';
      }
    }

    if (item && metaGrid && !metaGrid.querySelector('.browser-source-meta')) {
      const meta = document.createElement('div');
      meta.className = 'item-meta browser-source-meta';
      meta.innerHTML = `<span>Last browser-only download</span><strong>${item.browser_nfo_source ? `${esc(downloadedFrom(item.browser_nfo_source))}${item.browser_nfo_downloaded_at ? ` · ${esc(localTime(item.browser_nfo_downloaded_at))}` : ''}` : 'None'}</strong>`;
      metaGrid.appendChild(meta);
    } else if (item && metaGrid) {
      const strong = metaGrid.querySelector('.browser-source-meta strong');
      if (strong) strong.textContent = item.browser_nfo_source
        ? `${downloadedFrom(item.browser_nfo_source)}${item.browser_nfo_downloaded_at ? ` · ${localTime(item.browser_nfo_downloaded_at)}` : ''}`
        : 'None';
    }

    if (lastBrowserDownload && lastBrowserDownload.itemId === itemId) {
      const status = panel.querySelector('#item-operation-status');
      if (status && !status.textContent.includes('No files were written')) {
        status.textContent = `Last browser download · Downloaded from ${lastBrowserDownload.source} · No media-folder files were changed.`;
      }
    }
  }

  function enhanceAll() {
    renameTvEverywhere();
    enhanceLibrarySources();
    enhanceItemManager();
  }

  const observer = new MutationObserver(() => queueMicrotask(enhanceAll));
  observer.observe(document.documentElement, {childList:true, subtree:true});
  document.addEventListener('DOMContentLoaded', enhanceAll);
  setTimeout(enhanceAll, 0);
})();
