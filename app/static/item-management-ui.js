(() => {
  const nativeFetch = window.fetch.bind(window);
  const inventories = {movies: [], tv: []};
  const renderTokens = {movies: 0, tv: 0};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

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

  function activeKind(){
    const active = document.querySelector('.nav.active')?.dataset?.view;
    return active === 'movies' || active === 'tv' ? active : null;
  }

  function enhanceLibraryTable(kind=activeKind()){
    if (!kind || activeKind() !== kind) return false;
    const table = document.querySelector('#lib-table table');
    if (!table) return false;
    const rows = inventories[kind] || [];
    const trs = table.querySelectorAll('tbody tr');
    if (trs.length !== rows.length) return false;

    const head = table.querySelector('thead tr');
    if (head && !head.querySelector('.item-manage-head')) {
      const th = document.createElement('th');
      th.className = 'item-manage-head';
      th.textContent = 'Manage';
      head.appendChild(th);
    }

    for (let index = 0; index < trs.length; index += 1) {
      const tr = trs[index];
      const item = rows[index];
      if (!item || tr.querySelector('.item-manage-cell')) continue;
      const td = document.createElement('td');
      td.className = 'item-manage-cell';
      td.innerHTML = `<button class="btn secondary item-manage-btn" data-item-id="${Number(item.id)}">Manage NFO</button>`;
      tr.appendChild(td);
    }
    return true;
  }

  function scheduleEnhanceLibraryTable(kind){
    const token = ++renderTokens[kind];
    let attempt = 0;
    const run = () => {
      if (token !== renderTokens[kind] || activeKind() !== kind) return;
      if (enhanceLibraryTable(kind)) return;
      attempt += 1;
      if (attempt < 12) setTimeout(() => requestAnimationFrame(run), attempt < 4 ? 0 : 25);
    };
    requestAnimationFrame(run);
  }

  window.fetch = async (input, init={}) => {
    const response = await nativeFetch(input, init);
    const raw = typeof input === 'string' ? input : input?.url || '';
    const url = new URL(raw, location.origin);
    const match = url.pathname.match(/^\/api\/library\/(movies|tv)$/);
    const method = String(init.method || 'GET').toUpperCase();
    if (match && method === 'GET' && response.ok) {
      try {
        const kind = match[1];
        inventories[kind] = await response.clone().json();
        scheduleEnhanceLibraryTable(kind);
      } catch {}
    }
    return response;
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

  async function openManager(itemId){
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
          <div class="item-meta"><span>NFO source</span><strong>${esc(item.nfo_source || 'Local / Unknown')}</strong></div>
          <div class="item-meta"><span>Media file</span><strong>${item.media_exists ? 'Present' : 'Missing'}</strong></div>
        </div>
        <div class="item-path">${esc(item.media_path)}</div>

        <div class="item-actions">
          <button class="btn secondary item-recheck" data-item-id="${itemId}" ${item.media_exists?'':'disabled'}>Recheck item</button>
          <button class="btn primary item-fetch-nfo" data-item-id="${itemId}" data-policy="replace_all" ${isScene && item.media_exists?'':'disabled'}>Fetch / Replace NFO</button>
          <button class="btn secondary item-fetch-nfo" data-item-id="${itemId}" data-policy="missing_only" ${isScene && item.media_exists?'':'disabled'}>Add if missing</button>
          <button class="btn secondary item-download-source" data-item-id="${itemId}" ${isScene && item.media_exists?'':'disabled'}>Download fresh source NFO</button>
        </div>
        ${!isScene ? '<div class="run-hint">SceneNFO does not write or delete NFOs for P2P items. Recheck the item if you expect an exact PreDB Scene match.</div>' : ''}
        <div id="item-operation-status" class="item-operation-status">Ready.</div>

        <div class="item-section">
          <h3>Current NFO files</h3>
          <p>Generic metadata files such as movie.nfo, tvshow.nfo and season.nfo are protected. Only release NFOs identified as belonging to this verified Scene item can be deleted by SceneNFO.</p>
          ${nfos.length ? `<div class="nfo-file-list">${nfos.map(nfo => nfoFileHtml(itemId, nfo)).join('')}</div>` : '<div class="empty-state">No NFO files in this media folder.</div>'}
          ${item.managed_nfo_count > 1 ? `<div class="item-actions"><button class="btn danger item-delete-all-managed" data-item-id="${itemId}">Delete all ${item.managed_nfo_count} managed NFOs</button></div>` : ''}
        </div>`;

      bindPanel(panel, itemId);
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
        status('Downloading fresh source NFO…');
        await downloadBlob(`/api/items/${itemId}/nfo/source-download`);
        status('Fresh source NFO downloaded to your browser.', 'ok');
      } catch (error) { status(error.message, 'error'); }
    });

    panel.querySelectorAll('.download-current-nfo').forEach(button => button.addEventListener('click', async () => {
      try {
        await downloadBlob(`/api/items/${itemId}/nfo/download?name=${encodeURIComponent(button.dataset.name)}`);
        status(`Downloaded ${button.dataset.name}.`, 'ok');
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
