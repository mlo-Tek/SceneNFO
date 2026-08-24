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

  const resultLabel = value => String(value || '—').replaceAll('_', ' ');

  const libraryEntryHtml = item => {
    const classification = item.classification === 'scene' ? 'scene' : 'p2p';
    const title = item.title || item.release_name;
    const library = item.configured_library || 'Legacy';
    const nfoBadge = item.nfo_present
      ? '<span class="library-nfo-present">NFO PRESENT</span>'
      : '<span class="library-nfo-missing">NFO MISSING</span>';

    return `<article class="library-entry ${classification}">
      <div class="library-entry-main">
        <button class="library-title-link item-folder-btn" data-item-id="${Number(item.id)}" title="Open media folder in SceneNFO">${esc(title)}</button>
        <div class="library-entry-context">
          <span class="library-name-badge">${esc(library)}</span>
          <span class="library-release mono" title="${esc(item.release_name)}">${esc(item.release_name)}</span>
        </div>
        <div class="library-entry-actions">
          <button class="btn primary item-manage-btn" data-item-id="${Number(item.id)}">Manage NFO</button>
          <button class="btn secondary item-folder-btn" data-item-id="${Number(item.id)}">Browse folder</button>
        </div>
      </div>

      <div class="library-entry-meta">
        <div class="library-meta-block">
          <span class="library-meta-label">Type</span>
          <div>${pill(item.classification)}</div>
        </div>
        <div class="library-meta-block">
          <span class="library-meta-label">Group</span>
          <strong>${esc(item.release_group || 'Unknown')}</strong>
        </div>
        <div class="library-meta-block library-meta-nfo">
          <span class="library-meta-label">NFO</span>
          <div class="library-nfo-line">${nfoBadge}${nfoSourceHtml(item)}</div>
        </div>
        <div class="library-meta-block">
          <span class="library-meta-label">Last result</span>
          <strong class="library-result">${esc(resultLabel(item.last_result))}</strong>
        </div>
      </div>
    </article>`;
  };

  const sortOptions = () => `
    <option value="title:asc">Title · A → Z</option>
    <option value="title:desc">Title · Z → A</option>
    <option value="group:asc">Release group · A → Z</option>
    <option value="group:desc">Release group · Z → A</option>
    <option value="classification:desc">Type · Scene first</option>
    <option value="classification:asc">Type · P2P first</option>
    <option value="nfo:asc">NFO · Missing first</option>
    <option value="nfo:desc">NFO · Present first</option>
    <option value="result:asc">Last result · A → Z</option>
    <option value="result:desc">Last result · Z → A</option>
    <option value="library:asc">Library · A → Z</option>
    <option value="library:desc">Library · Z → A</option>
    <option value="release:asc">Release name · A → Z</option>
    <option value="release:desc">Release name · Z → A</option>`;

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
        <div><h2>${title}</h2><p>Filter, sort and manage the SceneNFO inventory. Click a title to browse its media folder.</p></div>
      </div>
      <div class="toolbar library-toolbar">
        <select id="lib-config"><option value="">All ${noun} libraries</option>${libs.map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('')}</select>
        <input id="lib-q" class="field grow" placeholder="Search title, release or group…">
        <select id="lib-class"><option value="">All types</option><option value="scene">Scene</option><option value="p2p">P2P</option></select>
        <select id="lib-nfo"><option value="">All NFO</option><option value="present">NFO present</option><option value="missing">NFO missing</option></select>
        <select id="lib-sort" title="Sort the complete matching library">${sortOptions()}</select>
        <button class="btn secondary" id="lib-filter">Apply</button>
      </div>
      <div id="lib-table" class="library-results"><div class="empty-state">Loading ${title}…</div></div>
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
      const [sort, direction] = String(document.querySelector('#lib-sort')?.value || 'title:asc').split(':');
      if (q) params.set('q', q);
      if (classification) params.set('classification', classification);
      if (nfo) params.set('nfo', nfo);
      if (libraryId) params.set('library_id', libraryId);
      params.set('sort', sort || 'title');
      params.set('direction', direction || 'asc');
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      return params;
    };

    const renderPage = page => {
      const rows = page.items || [];
      const entries = rows.length
        ? `<div class="library-entry-list">${rows.map(libraryEntryHtml).join('')}</div>`
        : '<div class="empty-state">No matching items.</div>';

      const pager = `<div class="library-pager">
        <div class="library-page-count">${pageStatus(page)}</div>
        <div class="library-page-controls">
          <label class="library-page-size">Rows <select class="lib-page-size"><option value="50" ${limit === 50 ? 'selected' : ''}>50</option><option value="100" ${limit === 100 ? 'selected' : ''}>100</option><option value="200" ${limit === 200 ? 'selected' : ''}>200</option></select></label>
          <button class="btn secondary lib-prev" ${page.offset <= 0 ? 'disabled' : ''}>Previous</button>
          <span class="summary-chip">Page ${page.page} / ${page.pages}</span>
          <button class="btn secondary lib-next" ${page.offset + page.limit >= page.total ? 'disabled' : ''}>Next</button>
        </div>
      </div>`;

      const target = document.querySelector('#lib-table');
      if (!target) return;
      target.innerHTML = `${pager}${entries}${pager}`;

      target.querySelectorAll('.lib-prev').forEach(button => button.onclick = () => {
        offset = Math.max(0, offset - limit);
        loadPage();
      });
      target.querySelectorAll('.lib-next').forEach(button => button.onclick = () => {
        offset += limit;
        loadPage();
      });
      target.querySelectorAll('.lib-page-size').forEach(select => select.onchange = event => {
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

    const resetAndLoad = () => {
      offset = 0;
      loadPage();
    };

    document.querySelector('#lib-filter').onclick = resetAndLoad;
    document.querySelector('#lib-q').addEventListener('keydown', event => {
      if (event.key === 'Enter') resetAndLoad();
    });
    document.querySelector('#lib-config').addEventListener('change', resetAndLoad);
    document.querySelector('#lib-class').addEventListener('change', resetAndLoad);
    document.querySelector('#lib-nfo').addEventListener('change', resetAndLoad);
    document.querySelector('#lib-sort').addEventListener('change', resetAndLoad);

    await loadPage();
  };
})();
