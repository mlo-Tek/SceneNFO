(() => {
  const html = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[ch]));

  const sourceLabel = source => ({
    srrdb: 'srrDB',
    predb: 'PreDB.club',
    crowdnfo: 'crowdNFO',
  }[String(source || '').toLowerCase()] || String(source || ''));

  const localTime = value => {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('de-DE', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(date);
  };

  function nfoText(item) {
    if (!item.nfo_present) return '<span class="recent-nfo missing">NFO missing</span>';
    const source = sourceLabel(item.nfo_source);
    return `<span class="recent-nfo present">NFO present${source ? ` · ${html(source)}` : ' · source unknown'}</span>`;
  }

  function recentRow(item, tv=false) {
    const title = item.display_title || item.title || item.release_name || 'Unknown';
    const episode = tv && item.episode ? `<span class="recent-episode">${html(item.episode)}</span>` : '';
    const classification = String(item.classification || '').toLowerCase();
    const type = classification === 'scene' ? 'SCENE' : classification === 'p2p' ? 'P2P' : '—';
    const group = item.release_group || 'Unknown group';

    return `<div class="recent-row">
      <div class="recent-main">
        <div class="recent-title"><strong>${html(title)}</strong>${episode}</div>
        <div class="recent-meta">
          <span>${html(localTime(item.updated_at))}</span>
          <span class="recent-type ${html(classification)}">${html(type)}</span>
          <span>${html(group)}</span>
        </div>
      </div>
      <div class="recent-side">${nfoText(item)}</div>
    </div>`;
  }

  function recentColumn(title, view, items, tv=false) {
    return `<section class="recent-column">
      <div class="recent-column-head">
        <h3>${html(title)}</h3>
        <button class="btn secondary recent-view-all" data-view="${html(view)}">View all</button>
      </div>
      <div class="recent-list">
        ${items?.length ? items.map(item => recentRow(item, tv)).join('') : '<div class="recent-empty">No inventoried items yet.</div>'}
      </div>
    </section>`;
  }

  async function enhanceRecentlyAdded() {
    if (typeof currentView !== 'undefined' && currentView !== 'dashboard') return;
    const stats = document.querySelector('.stats-grid');
    if (!stats) return;

    let data;
    try {
      data = await api('/api/dashboard/recent?limit=10');
    } catch (_) {
      return;
    }
    if (typeof currentView !== 'undefined' && currentView !== 'dashboard') return;

    document.querySelector('.recently-added-card')?.remove();
    const card = document.createElement('div');
    card.className = 'card section-card recently-added-card';
    card.innerHTML = `
      <div class="section-head recently-added-head">
        <div>
          <h2>Recently added</h2>
          <p>Latest imported or updated library items.</p>
        </div>
        <span class="pill info">RECENT</span>
      </div>
      <div class="recent-grid">
        ${recentColumn('Movies', 'movies', data.movies || [], false)}
        ${recentColumn('TV episodes', 'tv', data.tv || [], true)}
      </div>`;
    stats.insertAdjacentElement('afterend', card);

    card.querySelectorAll('.recent-view-all').forEach(button => {
      button.addEventListener('click', () => navigate(button.dataset.view));
    });
  }

  const previousDashboard = typeof renderDashboard === 'function' ? renderDashboard : null;
  if (previousDashboard) {
    renderDashboard = async function(...args) {
      const result = await previousDashboard(...args);
      await enhanceRecentlyAdded();
      return result;
    };
  }

  if (typeof currentView !== 'undefined' && currentView === 'dashboard') {
    setTimeout(() => enhanceRecentlyAdded().catch(() => {}), 0);
  }
})();
