(() => {
  const sourceLabel = source => ({
    srrdb: 'srrDB',
    predb: 'PreDB.club',
    crowdnfo: 'crowdNFO',
  }[String(source || '').toLowerCase()] || String(source || ''));

  const localTime = value => {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : new Intl.DateTimeFormat('de-DE', {
      dateStyle: 'short', timeStyle: 'short'
    }).format(d);
  };

  const nfoSourceHtml = item => {
    let installed;
    if (item.nfo_source) {
      installed = `<span class="source-installed">Downloaded from ${esc(sourceLabel(item.nfo_source))}</span>`;
    } else if (item.nfo_present) {
      installed = '<span class="source-unknown">Source unknown</span>';
    } else {
      installed = '<span class="source-none">No NFO installed</span>';
    }

    const browser = item.browser_nfo_source
      ? `<span class="source-browser">Browser only · Downloaded from ${esc(sourceLabel(item.browser_nfo_source))}${item.browser_nfo_downloaded_at ? ` · ${esc(localTime(item.browser_nfo_downloaded_at))}` : ''}</span>`
      : '';

    return `<div class="nfo-source-stack">${installed}${browser}</div>`;
  };

  const pageStatus = page => {
    if (!page.total) return '0 items';
    const first = page.offset + 1;
    const last = Math.min(page.offset + page.items.length, page.total);
    return `${first}–${last} of ${page.total}`;
  };

  renderLibrary = async function(kind) {
    const title = kind === 'movies' ? 'Movies' : 'TV';
    const noun = kind === 'movies' ? 'movie' : 'TV';

    let libs;
    try {
      libs = await api(`/api/libraries?kind=${kind}`);
    } catch (error) {
      content.innerHTML = `<div class="card section-card"><div class="empty-state apply-error">Failed to load ${esc(title)} libraries: ${esc(error.message)}</div></div>`;
      return;
    }

    content.innerHTML = `<div class="card section-card library-page-card">
      <div class="section-head">
        <div><h2>${title}</h2><p>Filter and manage the SceneNFO inventory. Results are paginated for stable performance.</p></div>
      </div>
      <div class="toolbar library-toolbar">
        <select id="lib-config"><option value="">All ${noun} libraries</option>${libs.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
        <input id="lib-q" class="field grow" placeholder="Search title, release or group…">
        <select id="lib-class"><option value="">All types</option><option value="scene">Scene</option><option value="p2p">P2P</option></select>
        <select id="lib-nfo"><option value="">All NFO</option><option value="present">NFO present</option><option value="missing">NFO missing</option></select>
        <button class="btn secondary" id="lib-filter">Apply filters</button>
      </div>
      <div id="lib-table" class="table-space"><div class="empty-state">Loading ${title}…</div></div>
    </div>`;

    let offset = 0;
    let limit = 100;
    let requestToken = 0;

    const buildParams = () => {
      const params = new URLSearchParams();
      const q = document.querySelector('#lib-q')?.value.trim();
      const classification = document.querySelector('#lib-class')?.value;
      const nfo = document.querySelector('#lib-nfo')?.value;
      const libraryId = document.querySelector('#lib-config')?.value;
      if (q) params.set('q', q);
      if (classification) params.set('classification', classification);
      if (nfo) params.set('nfo', nfo);
      if (libraryId) params.set('library_id', libraryId);
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      return params;
    };

    const renderPage = page => {
      const rows = page.items || [];
      const table = rows.length ? `<div class="table-wrap stable-library-table"><table>
        <thead><tr><th>Library</th><th>Title</th><th>Type</th><th>Group</th><th>NFO</th><th>NFO Source</th><th>Result</th><th>Release</th><th>Manage</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${esc(r.configured_library || 'Legacy')}</td>
          <td><strong>${esc(r.title || r.release_name)}</strong></td>
          <td>${pill(r.classification)}</td>
          <td>${esc(r.release_group || 'Unknown')}</td>
          <td>${r.nfo_present ? '<span class="library-nfo-present">NFO present</span>' : '<span class="library-nfo-missing">NFO missing</span>'}</td>
          <td>${nfoSourceHtml(r)}</td>
          <td>${esc(r.last_result || '')}</td>
          <td class="mono library-release-cell">${esc(r.release_name)}</td>
          <td><button class="btn secondary item-manage-btn" data-item-id="${Number(r.id)}">Manage NFO</button></td>
        </tr>`).join('')}</tbody>
      </table></div>` : '<div class="empty-state">No matching items.</div>';

      const pager = `<div class="library-pager">
        <div class="library-page-count">${pageStatus(page)}</div>
        <div class="library-page-controls">
          <label class="library-page-size">Rows <select id="lib-page-size"><option value="50" ${limit === 50 ? 'selected' : ''}>50</option><option value="100" ${limit === 100 ? 'selected' : ''}>100</option><option value="200" ${limit === 200 ? 'selected' : ''}>200</option></select></label>
          <button class="btn secondary" id="lib-prev" ${page.offset <= 0 ? 'disabled' : ''}>Previous</button>
          <span class="summary-chip">Page ${page.page} / ${page.pages}</span>
          <button class="btn secondary" id="lib-next" ${page.offset + page.limit >= page.total ? 'disabled' : ''}>Next</button>
        </div>
      </div>`;

      const target = document.querySelector('#lib-table');
      if (!target) return;
      target.innerHTML = `${pager}${table}${pager}`;

      target.querySelectorAll('#lib-prev').forEach(button => button.onclick = () => {
        offset = Math.max(0, offset - limit);
        loadPage();
      });
      target.querySelectorAll('#lib-next').forEach(button => button.onclick = () => {
        offset += limit;
        loadPage();
      });
      target.querySelectorAll('#lib-page-size').forEach(select => select.onchange = event => {
        limit = Number(event.target.value) || 100;
        offset = 0;
        loadPage();
      });
    };

    const loadPage = async () => {
      const token = ++requestToken;
      const target = document.querySelector('#lib-table');
      if (!target) return;
      target.classList.add('loading');
      try {
        const page = await api(`/api/library/${kind}/page?${buildParams().toString()}`);
        if (token !== requestToken || currentView !== kind) return;
        offset = Number(page.offset || 0);
        renderPage(page);
      } catch (error) {
        if (token !== requestToken) return;
        target.innerHTML = `<div class="empty-state apply-error">Failed to load ${esc(title)}: ${esc(error.message)}</div>`;
      } finally {
        target.classList.remove('loading');
      }
    };

    document.querySelector('#lib-filter').onclick = () => {
      offset = 0;
      loadPage();
    };
    document.querySelector('#lib-q').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        offset = 0;
        loadPage();
      }
    });
    document.querySelector('#lib-config').addEventListener('change', () => {
      offset = 0;
      loadPage();
    });

    await loadPage();
  };
})();
