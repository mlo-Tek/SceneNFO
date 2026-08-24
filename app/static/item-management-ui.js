(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  const sourceLabel = source => ({
    srrdb: 'srrDB',
    predb: 'PreDB.club',
    crowdnfo: 'crowdNFO',
  }[String(source || '').toLowerCase()] || String(source || ''));

  const downloadedFrom = source => source ? `Downloaded from ${sourceLabel(source)}` : '';

  const localTime = value => {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('de-DE', {
      dateStyle:'short', timeStyle:'short'
    }).format(d);
  };

  const formatBytes = value => {
    const bytes = Number(value || 0);
    if (!bytes) return '0 B';
    const units = ['B','KB','MB','GB','TB'];
    let size = bytes;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    const digits = unit >= 3 ? 2 : unit >= 2 ? 1 : 0;
    return `${size.toFixed(digits)} ${units[unit]}`;
  };

  const apiJson = async (url, opts={}) => {
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
  };

  function badge(text, cls='summary-chip'){
    return `<span class="${cls}">${esc(text)}</span>`;
  }

  function nfoFileHtml(itemId, nfo){
    const tags = [
      nfo.managed ? '<span class="tag-safe">SCENENFO MANAGED</span>' : '',
      nfo.generic ? '<span class="tag-protected">PROTECTED METADATA</span>' : '',
      nfo.recorded ? '<span class="tag-recorded">RECORDED</span>' : '',
    ].filter(Boolean).join('');
    return `<div class="nfo-file">
      <div>
        <div class="nfo-file-name">${esc(nfo.name)}</div>
        <div class="nfo-file-meta">${tags}${badge(`${Math.max(1, Math.round(Number(nfo.size || 0) / 1024))} KB`)}</div>
      </div>
      <div class="nfo-file-actions">
        <button class="btn secondary download-current-nfo" data-item-id="${itemId}" data-name="${esc(nfo.name)}">Download copy</button>
        ${nfo.managed ? `<button class="btn danger delete-current-nfo" data-item-id="${itemId}" data-name="${esc(nfo.name)}">Delete</button>` : ''}
      </div>
    </div>`;
  }

  function folderEntryHtml(entry){
    const isDir = entry.type === 'directory';
    const isLink = entry.type === 'symlink';
    const icon = isDir ? '▰' : isLink ? '↗' : entry.extension === '.nfo' ? 'NFO' : '•';
    const meta = isDir
      ? 'Folder'
      : isLink
        ? 'Symlink'
        : `${formatBytes(entry.size)} · ${localTime(entry.modified_at)}`;

    if (isDir && entry.navigable) {
      return `<button class="folder-entry folder-entry-directory" data-folder-path="${esc(entry.relative_path)}">
        <span class="folder-entry-icon">${icon}</span>
        <span class="folder-entry-name">${esc(entry.name)}</span>
        <span class="folder-entry-meta">${esc(meta)}</span>
        <span class="folder-entry-chevron">›</span>
      </button>`;
    }

    return `<div class="folder-entry ${entry.extension === '.nfo' ? 'folder-entry-nfo' : ''}">
      <span class="folder-entry-icon">${icon}</span>
      <span class="folder-entry-name">${esc(entry.name)}</span>
      <span class="folder-entry-meta">${esc(meta)}</span>
      <span></span>
    </div>`;
  }

  async function loadFolder(itemId, relativePath='', focus=false){
    const browser = document.querySelector('#item-folder-browser');
    if (!browser) return;
    browser.innerHTML = '<div class="empty-state">Loading folder…</div>';

    try {
      const params = new URLSearchParams();
      if (relativePath) params.set('path', relativePath);
      const folder = await apiJson(`/api/items/${itemId}/folder?${params.toString()}`);
      const pathLabel = folder.path ? `${folder.root}/${folder.path}` : folder.root;
      const entries = folder.entries || [];
      browser.innerHTML = `
        <div class="folder-browser-head">
          <div>
            <span class="folder-browser-label">Current folder</span>
            <div class="folder-browser-path mono">${esc(pathLabel)}</div>
          </div>
          <div class="folder-browser-actions">
            ${folder.parent_path !== null ? `<button class="btn secondary folder-up" data-folder-path="${esc(folder.parent_path || '')}">↑ Up</button>` : ''}
            <button class="btn secondary folder-refresh" data-folder-path="${esc(folder.path || '')}">Refresh</button>
          </div>
        </div>
        <div class="folder-browser-count">${entries.length} item${entries.length === 1 ? '' : 's'}</div>
        <div class="folder-entry-list">${entries.length ? entries.map(folderEntryHtml).join('') : '<div class="empty-state">Folder is empty.</div>'}</div>`;

      browser.querySelectorAll('[data-folder-path]').forEach(button => button.addEventListener('click', event => {
        const path = event.currentTarget.dataset.folderPath || '';
        loadFolder(itemId, path, false);
      }));

      if (focus) {
        requestAnimationFrame(() => document.querySelector('.folder-section')?.scrollIntoView({behavior:'smooth', block:'start'}));
      }
    } catch (error) {
      browser.innerHTML = `<div class="item-operation-status error">Folder browser failed: ${esc(error.message)}</div>`;
    }
  }

  async function openManager(itemId, options={}){
    let backdrop = document.querySelector('#item-manager-backdrop');
    if (!backdrop) {
      backdrop = document.createElement('div');
      backdrop.id = 'item-manager-backdrop';
      backdrop.className = 'item-manager-backdrop';
      document.body.appendChild(backdrop);
    }
    backdrop.innerHTML = `<aside class="item-manager"><div class="empty-state">Loading item…</div></aside>`;
    backdrop.style.display = 'flex';

    try {
      const item = await apiJson(`/api/items/${itemId}`);
      const panel = backdrop.querySelector('.item-manager');
      const isScene = item.classification === 'scene';
      const nfos = item.nfos || [];
      const installedSource = item.nfo_source
        ? downloadedFrom(item.nfo_source)
        : item.nfo_present ? 'Source unknown' : 'No NFO installed';
      const browserSource = item.browser_nfo_source
        ? `${downloadedFrom(item.browser_nfo_source)} · ${localTime(item.browser_nfo_downloaded_at)}`
        : 'None';

      panel.innerHTML = `
        <div class="item-manager-head">
          <div><h2>${esc(item.title || item.release_name)}</h2><p>${esc(item.configured_library || item.library || '')}</p></div>
          <button class="btn secondary item-manager-close" aria-label="Close">×</button>
        </div>
        <div class="item-meta-grid">
          <div class="item-meta"><span>Classification</span><strong>${isScene ? 'SCENE' : 'P2P'}</strong></div>
          <div class="item-meta"><span>Group</span><strong>${esc(item.release_group || 'Unknown')}</strong></div>
          <div class="item-meta"><span>Release</span><strong>${esc(item.release_name)}</strong></div>
          <div class="item-meta"><span>Last result</span><strong>${esc(item.last_result || '—')}</strong></div>
          <div class="item-meta"><span>NFO Source</span><strong>${esc(installedSource)}</strong></div>
          <div class="item-meta"><span>Last browser-only download</span><strong>${esc(browserSource)}</strong></div>
          <div class="item-meta"><span>Media file</span><strong>${item.media_exists ? 'Present' : 'Missing'}</strong></div>
        </div>
        <div class="item-path">${esc(item.media_path)}</div>

        <div class="item-actions">
          <button class="btn secondary item-recheck" data-item-id="${itemId}" ${item.media_exists?'':'disabled'}>Recheck item</button>
          <button class="btn primary item-fetch-nfo" data-item-id="${itemId}" data-policy="replace_all" ${isScene && item.media_exists?'':'disabled'}>Fetch / Replace NFO</button>
          <button class="btn secondary item-fetch-nfo" data-item-id="${itemId}" data-policy="missing_only" ${isScene && item.media_exists?'':'disabled'}>Add if missing</button>
          <button class="btn secondary item-download-source" data-item-id="${itemId}" ${isScene && item.media_exists?'':'disabled'}>Download NFO to browser</button>
        </div>
        <div class="browser-download-notice"><strong>Browser download only</strong><span>Downloads a fresh NFO copy to this browser. It does not create, replace or delete files in the media folder.</span></div>
        ${!isScene ? '<div class="run-hint">SceneNFO does not write or delete NFOs for P2P items. Recheck the item if you expect an exact PreDB Scene match.</div>' : ''}
        <div id="item-operation-status" class="item-operation-status">Ready.</div>

        <div class="item-section folder-section">
          <div class="item-section-heading"><div><h3>Folder contents</h3><p>Browse the complete media folder inside SceneNFO. Movies open their movie folder; TV opens the series root and its season folders.</p></div></div>
          <div id="item-folder-browser"><div class="empty-state">Loading folder…</div></div>
        </div>

        <div class="item-section">
          <h3>Current NFO files</h3>
          <p>Generic metadata files such as movie.nfo, tvshow.nfo and season.nfo are protected. Only release NFOs identified as belonging to this verified Scene item can be deleted by SceneNFO.</p>
          ${nfos.length ? `<div class="nfo-file-list">${nfos.map(nfo => nfoFileHtml(itemId, nfo)).join('')}</div>` : '<div class="empty-state">No NFO files in this media folder.</div>'}
          ${item.managed_nfo_count > 1 ? `<div class="item-actions"><button class="btn danger item-delete-all-managed" data-item-id="${itemId}">Delete all ${item.managed_nfo_count} managed NFOs</button></div>` : ''}
        </div>`;

      bindPanel(panel, itemId);
      await loadFolder(itemId, '', Boolean(options.focusFolder));
    } catch (error) {
      backdrop.querySelector('.item-manager').innerHTML = `<div class="item-manager-head"><div><h2>Item manager</h2></div><button class="btn secondary item-manager-close">×</button></div><div class="item-operation-status error">${esc(error.message)}</div>`;
      backdrop.querySelector('.item-manager-close').onclick = closeManager;
    }
  }

  function closeManager(){
    const backdrop = document.querySelector('#item-manager-backdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  function status(text, tone=''){
    const el = document.querySelector('#item-operation-status');
    if (!el) return;
    el.textContent = text;
    el.className = `item-operation-status ${tone}`.trim();
  }

  function monitorJob(jobId, itemId, prefix){
    status(`${prefix} started…`);
    const es = new EventSource(`/api/scans/${jobId}/events`);
    es.onmessage = event => {
      let data = {};
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === 'item') status(`${prefix}: ${data.action || 'processed'} · ${data.release || ''}`);
      if (data.type === 'item_error' || data.type === 'fatal') status(`${prefix} failed: ${data.message || data.type}`, 'error');
      if (data.type === 'complete') {
        es.close();
        status(`${prefix} completed.`, 'ok');
        setTimeout(() => {
          openManager(itemId);
          document.querySelector('#lib-filter')?.click();
        }, 450);
      }
      if (data.type === 'cancelled') {
        es.close();
        status(`${prefix} cancelled.`, 'error');
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) return;
      status(`${prefix}: live connection interrupted`, 'error');
    };
  }

  async function downloadBlob(url){
    const response = await fetch(url);
    if (!response.ok) {
      let text = await response.text();
      try { text = JSON.parse(text).detail || text; } catch {}
      throw new Error(String(text));
    }
    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] || 'release.nfo';
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    return response;
  }

  function bindPanel(panel, itemId){
    panel.querySelector('.item-manager-close').onclick = closeManager;

    panel.querySelector('.item-recheck')?.addEventListener('click', async () => {
      try {
        const result = await apiJson(`/api/items/${itemId}/recheck`, {method:'POST', body:JSON.stringify({nfo_policy:'replace_all'})});
        monitorJob(result.job_id, itemId, 'Recheck');
      } catch (error) { status(error.message, 'error'); }
    });

    panel.querySelectorAll('.item-fetch-nfo').forEach(button => button.addEventListener('click', async () => {
      const policy = button.dataset.policy || 'replace_all';
      const label = policy === 'replace_all' ? 'Fetch / Replace NFO' : 'Add NFO if missing';
      if (!confirm(`${label}? This writes to the media folder.`)) return;
      try {
        const result = await apiJson(`/api/items/${itemId}/nfo/fetch`, {method:'POST', body:JSON.stringify({nfo_policy:policy})});
        monitorJob(result.job_id, itemId, label);
      } catch (error) { status(error.message, 'error'); }
    }));

    panel.querySelector('.item-download-source')?.addEventListener('click', async () => {
      try {
        status('Downloading fresh NFO to this browser only…');
        const response = await downloadBlob(`/api/items/${itemId}/nfo/source-download`);
        const source = response.headers.get('X-SceneNFO-Source-Label') || sourceLabel(response.headers.get('X-SceneNFO-Source')) || 'Unknown';
        status(`Browser download complete · Downloaded from ${source} · No media-folder files were changed.`, 'ok');
      } catch (error) { status(error.message, 'error'); }
    });

    panel.querySelectorAll('.download-current-nfo').forEach(button => button.addEventListener('click', async () => {
      try {
        await downloadBlob(`/api/items/${itemId}/nfo/download?name=${encodeURIComponent(button.dataset.name)}`);
        status(`Downloaded ${button.dataset.name} to your browser.`, 'ok');
      } catch (error) { status(error.message, 'error'); }
    }));

    panel.querySelectorAll('.delete-current-nfo').forEach(button => button.addEventListener('click', async () => {
      const name = button.dataset.name;
      if (!confirm(`Delete ${name} from the media folder?`)) return;
      try {
        const result = await apiJson(`/api/items/${itemId}/nfo/delete`, {method:'POST', body:JSON.stringify({names:[name],delete_all_managed:false})});
        status(`Deleted ${result.deleted.join(', ')}.`, 'ok');
        await openManager(itemId);
        document.querySelector('#lib-filter')?.click();
      } catch (error) { status(error.message, 'error'); }
    }));

    panel.querySelector('.item-delete-all-managed')?.addEventListener('click', async () => {
      if (!confirm('Delete all SceneNFO-managed release NFOs for this item? Generic metadata NFOs remain protected.')) return;
      try {
        const result = await apiJson(`/api/items/${itemId}/nfo/delete`, {method:'POST', body:JSON.stringify({names:[],delete_all_managed:true})});
        status(`Deleted ${result.deleted.length} managed NFO file(s).`, 'ok');
        await openManager(itemId);
        document.querySelector('#lib-filter')?.click();
      } catch (error) { status(error.message, 'error'); }
    });
  }

  document.addEventListener('click', event => {
    const folder = event.target.closest?.('.item-folder-btn');
    if (folder) {
      event.preventDefault();
      openManager(Number(folder.dataset.itemId), {focusFolder:true});
      return;
    }

    const manage = event.target.closest?.('.item-manage-btn');
    if (manage) {
      event.preventDefault();
      openManager(Number(manage.dataset.itemId));
      return;
    }

    if (event.target.id === 'item-manager-backdrop') closeManager();
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeManager();
  });
})();
