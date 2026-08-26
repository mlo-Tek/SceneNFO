(() => {
  const escHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const sourceLabel = source => ({srrdb:'srrDB',predb:'PreDB.club',crowdnfo:'crowdNFO'})[String(source || '').toLowerCase()] || source || '—';

  let nfoChanges = new Map();

  const actionMeta = action => {
    const a = String(action || '').toUpperCase();
    if (a === 'WOULD_CREATE') return {label:'Would create', tone:'create', changed:true};
    if (a === 'WOULD_REPLACE') return {label:'Would replace', tone:'replace', changed:true};
    if (a === 'CREATED') return {label:'Created', tone:'create', changed:true};
    if (a === 'REPLACED_CHANGED') return {label:'Replaced · changed', tone:'replace', changed:true};
    if (a === 'REPLACED_IDENTICAL') return {label:'Replaced · identical', tone:'replace', changed:true};
    return {label:a || '—', tone:'', changed:false};
  };

  function mediaTitle(row) {
    const title = String(row?.title || '').trim();
    if (title && !/^Season\s+\d+/i.test(title)) return title;

    const path = String(row?.media_path || '').replace(/\\/g, '/');
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 3) {
      const parent = parts[parts.length - 2] || '';
      if (/^Season\s+\d+/i.test(parent) && parts.length >= 4) return parts[parts.length - 3];
      return parent || title || row?.release || 'Unknown media';
    }
    return title || row?.release || 'Unknown media';
  }

  function rememberChanges() {
    if (typeof liveRows === 'undefined') return;
    for (const row of liveRows) {
      const meta = actionMeta(row.action);
      if (!meta.changed) continue;
      const key = row.media_path || `${row.library_name || ''}|${row.release || ''}`;
      nfoChanges.set(key, {
        ...row,
        display_title: mediaTitle(row),
        action_label: meta.label,
        action_tone: meta.tone,
      });
    }
  }

  function decorateLiveRows() {
    if (typeof liveRows === 'undefined') return;
    const nodes = [...document.querySelectorAll('#live-list .live-result-row')];
    nodes.forEach((node, index) => {
      const row = liveRows[index];
      if (!row) return;
      const releaseNode = node.querySelector('.live-result-release');
      if (!releaseNode) return;
      let titleNode = node.querySelector('.live-result-media-title');
      if (!titleNode) {
        titleNode = document.createElement('div');
        titleNode.className = 'live-result-media-title';
        releaseNode.parentNode.insertBefore(titleNode, releaseNode);
      }
      titleNode.textContent = mediaTitle(row);
      titleNode.title = mediaTitle(row);
      releaseNode.classList.add('live-result-release-secondary');
    });
  }

  function numberFromText(text, label) {
    const match = String(text || '').match(new RegExp(`(\\d+)\\s+${label}`, 'i'));
    return match ? Number(match[1]) : 0;
  }

  function renderChangesList() {
    const rows = [...nfoChanges.values()];
    if (!rows.length) return '<div class="scan-change-empty">No NFO files were created or replaced in this run.</div>';
    return `<div class="scan-change-list">${rows.map(row => `
      <div class="scan-change-row">
        <div class="scan-change-main">
          <div class="scan-change-title">${escHtml(row.display_title)}</div>
          <div class="scan-change-release">${escHtml(row.release || '')}</div>
        </div>
        <div class="scan-change-meta">
          <span class="scan-change-action ${escHtml(row.action_tone)}">${escHtml(row.action_label)}</span>
          <span class="scan-change-source">${row.nfo_source ? `Downloaded from ${escHtml(sourceLabel(row.nfo_source))}` : 'Source unavailable'}</span>
        </div>
      </div>`).join('')}</div>`;
  }

  function renderRunSummary(summary, apply, nfoPolicy, totals) {
    const controls = document.querySelector('.scan-controls');
    if (!controls) return;
    document.querySelector('#scan-result-summary')?.remove();

    const changes = [...nfoChanges.values()];
    const created = Number(summary?.created || 0);
    const replaced = Number(summary?.replaced || 0);
    const errors = Number(summary?.errors || 0);
    const scanned = Number(totals.scanned || (Number(summary?.scene || 0) + Number(summary?.p2p || 0) + errors));

    const card = document.createElement('section');
    card.id = 'scan-result-summary';
    card.className = 'card scan-result-summary';
    card.innerHTML = `
      <div class="scan-result-head">
        <div>
          <div class="scan-result-eyebrow">RUN COMPLETE</div>
          <h2>${apply ? 'Apply run completed' : 'Dry Run completed'}</h2>
          <p>${escHtml(nfoPolicy === 'replace_all' ? 'Replace all Scene NFOs' : 'Only add missing NFOs')} · ${scanned} scanned</p>
        </div>
        <span class="scan-result-status">Completed</span>
      </div>
      <div class="scan-result-metrics">
        <div class="scan-result-metric"><span>Scanned</span><strong>${scanned}</strong></div>
        <div class="scan-result-metric scene"><span>Scene</span><strong>${Number(summary?.scene || 0)}</strong></div>
        <div class="scan-result-metric p2p"><span>P2P</span><strong>${Number(summary?.p2p || 0)}</strong></div>
        <div class="scan-result-metric created"><span>NFO created</span><strong>${created}</strong></div>
        <div class="scan-result-metric replaced"><span>NFO replaced</span><strong>${replaced}</strong></div>
        <div class="scan-result-metric errors"><span>Errors</span><strong>${errors}</strong></div>
      </div>
      <div class="scan-result-secondary">
        <span>${Number(totals.unchanged || 0)} unchanged</span>
        <span>${Number(totals.removed || 0)} removed</span>
        <span>${changes.length} NFO ${apply ? 'changes' : 'planned changes'}</span>
      </div>
      <details class="scan-change-details">
        <summary>
          <span><strong>NFO changes</strong><small>${apply ? 'Show every movie / episode whose NFO was created or replaced.' : 'Show every movie / episode that would receive a new or replacement NFO.'}</small></span>
          <span class="scan-change-count">${changes.length}</span>
        </summary>
        ${renderChangesList()}
      </details>`;
    controls.insertAdjacentElement('afterend', card);
  }

  const previousRenderLiveRows = typeof renderLiveRows === 'function' ? renderLiveRows : null;
  if (previousRenderLiveRows) {
    renderLiveRows = function(...args) {
      rememberChanges();
      const result = previousRenderLiveRows(...args);
      decorateLiveRows();
      return result;
    };
  }

  const previousStartMultiLibraryScan = typeof startMultiLibraryScan === 'function' ? startMultiLibraryScan : null;
  if (previousStartMultiLibraryScan) {
    startMultiLibraryScan = async function(...args) {
      nfoChanges = new Map();
      document.querySelector('#scan-result-summary')?.remove();
      return previousStartMultiLibraryScan(...args);
    };
  }

  const previousFinishBatchIfDone = typeof finishBatchIfDone === 'function' ? finishBatchIfDone : null;
  if (previousFinishBatchIfDone) {
    finishBatchIfDone = function(summary, apply, nfoPolicy, ...rest) {
      const jobsBefore = typeof activeJobs !== 'undefined' ? [...activeJobs.values()] : [];
      const allDone = jobsBefore.length > 0 && jobsBefore.every(job => job.done);
      const scanned = jobsBefore.reduce((sum, job) => sum + Number(job.total || job.index || 0), 0);
      const result = previousFinishBatchIfDone(summary, apply, nfoPolicy, ...rest);
      if (allDone) {
        rememberChanges();
        decorateLiveRows();
        const countsText = document.querySelector('#scan-counts')?.textContent || '';
        renderRunSummary(summary, apply, nfoPolicy, {
          scanned,
          unchanged:numberFromText(countsText, 'unchanged'),
          removed:numberFromText(countsText, 'removed'),
        });
      }
      return result;
    };
  }

  decorateLiveRows();
})();
