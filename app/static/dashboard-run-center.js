(() => {
  const settingValue = (settings, key, fallback='') => {
    const value = settings?.[key];
    return typeof value === 'object' ? (value.value || fallback) : (value ?? fallback);
  };

  const humanPolicy = value => value === 'replace_all'
    ? 'Always download / replace Scene NFO'
    : 'Only add missing Scene NFOs';
  const humanScope = value => value === 'full' ? 'Full rescan' : 'New / changed only';
  const humanMode = value => value ? 'Apply' : 'Dry Run';

  async function openSettingsSection(title){
    await navigate('settings');
    setTimeout(() => {
      const heading = [...document.querySelectorAll('.settings-section h2')]
        .find(node => node.textContent.trim() === title);
      heading?.closest('.settings-section')?.scrollIntoView({behavior:'smooth', block:'start'});
    }, 80);
  }

  async function enhanceDashboardRunCenter(){
    if (currentView !== 'dashboard') return;
    const card = document.querySelector('.dashboard-run-card');
    if (!card || card.dataset.runCenter === '1') return;
    card.dataset.runCenter = '1';

    const head = card.querySelector('.section-head');
    const title = head?.querySelector('h2');
    const copy = head?.querySelector('p');
    const badge = head?.querySelector('.pill');
    if (title) title.textContent = 'Run center';
    if (copy) copy.textContent = 'Start a manual scan or switch to import and scheduled automation.';
    if (badge) badge.textContent = 'RUN CENTER';

    const quick = card.querySelector('.quick-run-grid');
    if (!quick) return;
    quick.classList.add('run-center-panel');
    quick.dataset.panel = 'quick';

    const tabs = document.createElement('div');
    tabs.className = 'run-center-tabs';
    tabs.innerHTML = `
      <button class="run-center-tab" data-tab="quick">Quick run</button>
      <button class="run-center-tab" data-tab="automatic">Automatic imports</button>
      <button class="run-center-tab" data-tab="schedules">Schedules</button>`;
    quick.parentNode.insertBefore(tabs, quick);

    const automatic = document.createElement('div');
    automatic.className = 'run-center-panel run-center-automation';
    automatic.dataset.panel = 'automatic';
    automatic.hidden = true;
    quick.parentNode.insertBefore(automatic, quick.nextSibling);

    const schedulesPanel = document.createElement('div');
    schedulesPanel.className = 'run-center-panel run-center-schedules';
    schedulesPanel.dataset.panel = 'schedules';
    schedulesPanel.hidden = true;
    automatic.parentNode.insertBefore(schedulesPanel, automatic.nextSibling);

    let settings = {};
    let schedules = [];
    let libraries = [];
    try {
      [settings, schedules, libraries] = await Promise.all([
        api('/api/settings'),
        api('/api/schedules'),
        api('/api/libraries'),
      ]);
    } catch (_) {}

    const radarrEnabled = settingValue(settings, 'radarr_webhook_enabled', 'true');
    const sonarrEnabled = settingValue(settings, 'sonarr_webhook_enabled', 'true');
    const apply = settingValue(settings, 'import_apply', 'false');
    const policy = settingValue(settings, 'import_nfo_policy', 'replace_all');
    const debounce = settingValue(settings, 'sonarr_import_debounce_seconds', '30');

    automatic.innerHTML = `
      <div class="run-center-panel-head">
        <div>
          <h3>Automatic import runs</h3>
          <p>Radarr targets the imported movie immediately. Sonarr batches consecutive episode imports from the same series.</p>
        </div>
        <span class="pill scene">TARGETED</span>
      </div>
      <div class="run-center-auto-grid">
        <label class="stack-field"><span>Radarr webhook</span><select id="dash-auto-radarr"><option value="true" ${radarrEnabled==='true'?'selected':''}>Enabled</option><option value="false" ${radarrEnabled==='false'?'selected':''}>Disabled</option></select></label>
        <label class="stack-field"><span>Sonarr webhook</span><select id="dash-auto-sonarr"><option value="true" ${sonarrEnabled==='true'?'selected':''}>Enabled</option><option value="false" ${sonarrEnabled==='false'?'selected':''}>Disabled</option></select></label>
        <label class="stack-field"><span>Automatic run mode</span><select id="dash-auto-mode"><option value="false" ${apply==='false'?'selected':''}>Dry Run — analyze only</option><option value="true" ${apply==='true'?'selected':''}>Apply — write NFO changes</option></select></label>
        <label class="stack-field"><span>NFO handling</span><select id="dash-auto-policy"><option value="missing_only" ${policy==='missing_only'?'selected':''}>Only add missing Scene NFOs</option><option value="replace_all" ${policy==='replace_all'?'selected':''}>Always download / replace Scene NFO</option></select></label>
        <label class="stack-field"><span>Sonarr batch debounce</span><div class="run-center-number"><input id="dash-auto-debounce" type="number" min="5" max="300" value="${esc(debounce)}"><span>seconds</span></div></label>
      </div>
      <div class="run-center-summary-row">
        <span><strong>Radarr</strong> exact imported MKV · immediate</span>
        <span><strong>Sonarr</strong> exact imported MKVs · ${esc(debounce)}s batch window</span>
      </div>
      <div class="run-center-actions">
        <button class="btn secondary" id="dash-auto-settings">Open full settings</button>
        <button class="btn primary" id="dash-auto-save">Save automatic run</button>
      </div>`;

    const libraryMap = new Map((libraries || []).map(lib => [Number(lib.id), lib.name]));
    if (!schedules?.length) {
      schedulesPanel.innerHTML = `
        <div class="run-center-panel-head"><div><h3>Scheduled runs</h3><p>No scheduled runs are configured yet.</p></div><span class="pill info">0 SCHEDULES</span></div>
        <div class="run-center-empty">Create a schedule to run selected libraries automatically at a specific time.</div>
        <div class="run-center-actions"><button class="btn primary" id="dash-schedule-settings">Create schedule</button></div>`;
    } else {
      schedulesPanel.innerHTML = `
        <div class="run-center-panel-head"><div><h3>Scheduled runs</h3><p>Time-based runs configured in Settings.</p></div><span class="pill info">${schedules.length} SCHEDULES</span></div>
        <div class="run-center-schedule-list">${schedules.map(schedule => {
          const names = (schedule.library_ids || []).map(id => libraryMap.get(Number(id)) || `Library ${id}`);
          return `<div class="run-center-schedule-card ${schedule.enabled?'enabled':'disabled'}">
            <div class="run-center-schedule-title"><strong>${esc(schedule.name)}</strong><span class="pill ${schedule.enabled?'scene':'info'}">${schedule.enabled?'ENABLED':'DISABLED'}</span></div>
            <div class="run-center-schedule-meta">
              <span><b>Cron</b>${esc(schedule.cron)}</span>
              <span><b>Mode</b>${humanMode(Boolean(schedule.apply_changes))}</span>
              <span><b>NFO</b>${esc(humanPolicy(schedule.nfo_policy))}</span>
              <span><b>Scope</b>${esc(humanScope(schedule.scan_scope))}</span>
            </div>
            <div class="run-center-schedule-libs">${names.map(name => `<span>${esc(name)}</span>`).join('')}</div>
          </div>`;
        }).join('')}</div>
        <div class="run-center-actions"><button class="btn secondary" id="dash-schedule-settings">Manage schedules</button></div>`;
    }

    const activate = tab => {
      localStorage.setItem('scenenfo-dashboard-run-tab', tab);
      card.querySelectorAll('.run-center-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
      card.querySelectorAll('.run-center-panel').forEach(panel => { panel.hidden = panel.dataset.panel !== tab; });
    };
    card.querySelectorAll('.run-center-tab').forEach(button => button.onclick = () => activate(button.dataset.tab));
    activate(localStorage.getItem('scenenfo-dashboard-run-tab') || 'quick');

    const save = document.querySelector('#dash-auto-save');
    if (save) save.onclick = async () => {
      const values = {
        radarr_webhook_enabled: document.querySelector('#dash-auto-radarr').value,
        sonarr_webhook_enabled: document.querySelector('#dash-auto-sonarr').value,
        import_apply: document.querySelector('#dash-auto-mode').value,
        import_nfo_policy: document.querySelector('#dash-auto-policy').value,
        sonarr_import_debounce_seconds: document.querySelector('#dash-auto-debounce').value,
      };
      await api('/api/settings', {method:'PUT', body:JSON.stringify({values})});
      toast('Automatic import settings saved', 'success');
    };
    document.querySelector('#dash-auto-settings')?.addEventListener('click', () => openSettingsSection('Import automation'));
    document.querySelector('#dash-schedule-settings')?.addEventListener('click', () => openSettingsSection('Schedules'));
  }

  const original = typeof renderDashboard === 'function' ? renderDashboard : null;
  if (original) {
    renderDashboard = async function(...args){
      const result = await original(...args);
      await enhanceDashboardRunCenter();
      return result;
    };
  }

  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (currentView === 'dashboard' && document.querySelector('.dashboard-run-card')) {
      enhanceDashboardRunCenter().catch(() => {});
    }
    if (attempts > 40 || document.querySelector('.dashboard-run-card[data-run-center="1"]')) clearInterval(timer);
  }, 75);
})();
