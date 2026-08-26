(() => {
  const settingValue = (settings, key, fallback='') => {
    const value = settings?.[key];
    return typeof value === 'object' ? (value.value || fallback) : (value ?? fallback);
  };

  function integrationPanel(kind, settings){
    const label = kind === 'radarr' ? 'Radarr' : 'Sonarr';
    const target = kind === 'radarr' ? 'changed movies' : 'changed series';
    const command = kind === 'radarr' ? 'RefreshMovie' : 'RefreshSeries';
    const url = settingValue(settings, `${kind}_base_url`, '');
    const key = settingValue(settings, `${kind}_api_key`, '');
    const refreshEnabled = settingValue(settings, `${kind}_refresh_after_apply`, 'true');

    const panel = document.createElement('div');
    panel.className = `import-targeting-panel arr-integration-panel ${kind}-integration-panel`;
    panel.innerHTML = `
      <div class="import-targeting-head">
        <div><strong>${label} integration</strong><span>Refresh ${target} after SceneNFO writes NFO files</span></div>
        <span class="pill info">${label.toUpperCase()}</span>
      </div>
      <div class="arr-integration-grid">
        <label class="stack-field">
          <span>${label} URL</span>
          <input class="field automation-setting" data-key="${kind}_base_url" value="${esc(url)}" placeholder="http://${kind}:${kind === 'radarr' ? '7878' : '8989'}">
        </label>
        <label class="stack-field">
          <span>${label} API key</span>
          <input type="password" class="field automation-setting" data-key="${kind}_api_key" value="${esc(key)}" placeholder="API key">
        </label>
        <label class="stack-field">
          <span>Refresh after NFO writes</span>
          <select class="automation-setting" data-key="${kind}_refresh_after_apply">
            <option value="true" ${refreshEnabled === 'true' ? 'selected' : ''}>Enabled</option>
            <option value="false" ${refreshEnabled === 'false' ? 'selected' : ''}>Disabled</option>
          </select>
        </label>
      </div>
      <div class="run-hint">Only successful ${kind === 'radarr' ? 'Movies' : 'TV'} Apply writes trigger ${label}. SceneNFO resolves the affected ${kind === 'radarr' ? 'movie IDs' : 'series IDs'} and queues targeted <strong>${command}</strong> ${kind === 'radarr' ? 'for the changed movies' : 'once per affected series'}. Dry Runs never trigger a refresh.</div>
      <div class="editor-actions arr-test-actions">
        <button class="btn secondary" type="button" data-test-arr="${kind}">Test ${label}</button>
        <span class="muted" data-test-status="${kind}"></span>
      </div>`;
    return panel;
  }

  function bindTest(panel, kind){
    const label = kind === 'radarr' ? 'Radarr' : 'Sonarr';
    const testButton = panel.querySelector(`[data-test-arr="${kind}"]`);
    const status = panel.querySelector(`[data-test-status="${kind}"]`);
    testButton.onclick = async () => {
      testButton.disabled = true;
      status.textContent = 'Testing…';
      try {
        const values = {};
        panel.querySelectorAll('.automation-setting').forEach(input => {
          values[input.dataset.key] = input.value;
        });
        await api('/api/settings', {method:'PUT', body:JSON.stringify({values})});
        const result = await api(`/api/integrations/${kind}/test`);
        if (result.ok) {
          const details = [result.instanceName, result.version].filter(Boolean).join(' · ');
          status.textContent = details ? `Connected · ${details}` : 'Connected';
          toast(`${label} connection successful`, 'success');
        } else {
          status.textContent = result.error || 'Connection failed';
          toast(`${label} connection failed`, 'warning');
        }
      } catch (error) {
        status.textContent = String(error.message || error);
        toast(`${label} connection failed`, 'warning');
      } finally {
        testButton.disabled = false;
      }
    };
  }

  async function enhanceArrIntegrations(){
    if (currentView !== 'settings') return;
    const heading = [...document.querySelectorAll('.settings-section h2')]
      .find(node => node.textContent.trim() === 'Import automation');
    const card = heading?.closest('.settings-section');
    if (!card || card.dataset.arrIntegrationUi === '1') return;
    card.dataset.arrIntegrationUi = '1';

    let settings = {};
    try { settings = await api('/api/settings'); } catch (_) {}

    const targeting = card.querySelector('.import-targeting-panel');
    const actions = card.querySelector('.editor-actions');
    if (!actions) return;

    const radarr = integrationPanel('radarr', settings);
    const sonarr = integrationPanel('sonarr', settings);
    card.insertBefore(radarr, targeting || actions);
    card.insertBefore(sonarr, targeting || actions);
    bindTest(radarr, 'radarr');
    bindTest(sonarr, 'sonarr');
  }

  const originalRenderSettings = typeof renderSettings === 'function' ? renderSettings : null;
  if (originalRenderSettings) {
    renderSettings = async function(...args){
      const result = await originalRenderSettings(...args);
      await enhanceArrIntegrations();
      return result;
    };
  }
})();
