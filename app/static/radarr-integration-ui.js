(() => {
  const settingValue = (settings, key, fallback='') => {
    const value = settings?.[key];
    return typeof value === 'object' ? (value.value || fallback) : (value ?? fallback);
  };

  async function enhanceRadarrIntegration(){
    if (currentView !== 'settings') return;
    const heading = [...document.querySelectorAll('.settings-section h2')]
      .find(node => node.textContent.trim() === 'Import automation');
    const card = heading?.closest('.settings-section');
    if (!card || card.dataset.radarrIntegrationUi === '1') return;
    card.dataset.radarrIntegrationUi = '1';

    let settings = {};
    try { settings = await api('/api/settings'); } catch (_) {}

    const targeting = card.querySelector('.import-targeting-panel');
    const actions = card.querySelector('.editor-actions');
    if (!actions) return;

    const url = settingValue(settings, 'radarr_base_url', '');
    const key = settingValue(settings, 'radarr_api_key', '');
    const refreshEnabled = settingValue(settings, 'radarr_refresh_after_apply', 'true');

    const panel = document.createElement('div');
    panel.className = 'import-targeting-panel radarr-integration-panel';
    panel.innerHTML = `
      <div class="import-targeting-head">
        <div><strong>Radarr integration</strong><span>Refresh changed movies after SceneNFO writes NFO files</span></div>
        <span class="pill info">RADARR</span>
      </div>
      <div class="radarr-integration-grid">
        <label class="stack-field">
          <span>Radarr URL</span>
          <input class="field automation-setting" data-key="radarr_base_url" value="${esc(url)}" placeholder="http://radarr:7878">
        </label>
        <label class="stack-field">
          <span>Radarr API key</span>
          <input type="password" class="field automation-setting" data-key="radarr_api_key" value="${esc(key)}" placeholder="API key">
        </label>
        <label class="stack-field">
          <span>Refresh after NFO writes</span>
          <select class="automation-setting" data-key="radarr_refresh_after_apply">
            <option value="true" ${refreshEnabled === 'true' ? 'selected' : ''}>Enabled</option>
            <option value="false" ${refreshEnabled === 'false' ? 'selected' : ''}>Disabled</option>
          </select>
        </label>
      </div>
      <div class="run-hint">Only successful Movies Apply writes trigger Radarr. SceneNFO resolves the affected movie IDs and queues one targeted <strong>RefreshMovie</strong> command after the run. Dry Runs never trigger a refresh.</div>
      <div class="editor-actions radarr-test-actions">
        <button class="btn secondary" type="button" id="test-radarr">Test Radarr</button>
        <span class="muted" id="radarr-test-status"></span>
      </div>`;

    card.insertBefore(panel, targeting || actions);

    const testButton = panel.querySelector('#test-radarr');
    testButton.onclick = async () => {
      const status = panel.querySelector('#radarr-test-status');
      testButton.disabled = true;
      status.textContent = 'Testing…';
      try {
        const values = {};
        panel.querySelectorAll('.automation-setting').forEach(input => {
          values[input.dataset.key] = input.value;
        });
        await api('/api/settings', {method:'PUT', body:JSON.stringify({values})});
        const result = await api('/api/integrations/radarr/test');
        if (result.ok) {
          const details = [result.instanceName, result.version].filter(Boolean).join(' · ');
          status.textContent = details ? `Connected · ${details}` : 'Connected';
          toast('Radarr connection successful', 'success');
        } else {
          status.textContent = result.error || 'Connection failed';
          toast('Radarr connection failed', 'warning');
        }
      } catch (error) {
        status.textContent = String(error.message || error);
        toast('Radarr connection failed', 'warning');
      } finally {
        testButton.disabled = false;
      }
    };
  }

  const originalRenderSettings = typeof renderSettings === 'function' ? renderSettings : null;
  if (originalRenderSettings) {
    renderSettings = async function(...args){
      const result = await originalRenderSettings(...args);
      await enhanceRadarrIntegration();
      return result;
    };
  }
})();
