(() => {
  const settingValue = (settings, key, fallback='') => {
    const value = settings?.[key];
    return typeof value === 'object' ? (value.value || fallback) : (value ?? fallback);
  };

  async function enhanceImportAutomation(){
    if (currentView !== 'settings') return;
    const headings = [...document.querySelectorAll('.settings-section h2')];
    const heading = headings.find(node => node.textContent.trim() === 'Import automation');
    const card = heading?.closest('.settings-section');
    if (!card || card.dataset.targetedImportUi === '1') return;
    card.dataset.targetedImportUi = '1';

    let settings = {};
    try { settings = await api('/api/settings'); } catch (_) {}

    const description = heading.parentElement?.querySelector('p');
    if (description) {
      description.textContent = 'Trigger targeted runs when Radarr or Sonarr imports or upgrades media. Radarr runs immediately; Sonarr groups consecutive episode imports into one batch.';
    }

    const fields = [...card.querySelectorAll('label.stack-field')];
    const modeField = fields.find(label => label.querySelector('span')?.textContent.trim() === 'Import mode');
    if (modeField) {
      modeField.querySelector('span').textContent = 'Automatic run mode';
      const select = modeField.querySelector('select');
      if (select) {
        const dry = select.querySelector('option[value="false"]');
        const apply = select.querySelector('option[value="true"]');
        if (dry) dry.textContent = 'Dry Run — analyze only';
        if (apply) apply.textContent = 'Apply — write NFO changes';
      }
    }

    const policyField = fields.find(label => label.querySelector('span')?.textContent.trim() === 'NFO handling');
    if (policyField) {
      const select = policyField.querySelector('select');
      if (select) {
        const missing = select.querySelector('option[value="missing_only"]');
        const replace = select.querySelector('option[value="replace_all"]');
        if (missing) missing.textContent = 'Only add missing Scene NFOs';
        if (replace) replace.textContent = 'Always download / replace Scene NFO';
      }
    }

    const actions = card.querySelector('.editor-actions');
    if (!actions) return;

    const debounce = settingValue(settings, 'sonarr_import_debounce_seconds', '30');
    const fallbackWindow = settingValue(settings, 'import_fallback_window_minutes', '10');
    const fallbackMax = settingValue(settings, 'import_fallback_max_files', '5');

    const block = document.createElement('div');
    block.className = 'import-targeting-panel';
    block.innerHTML = `
      <div class="import-targeting-head">
        <div><strong>Targeting</strong><span>Exact imported MKV</span></div>
        <span class="pill scene">TARGETED</span>
      </div>
      <p>Radarr/Sonarr file paths are used directly. Radarr normally starts one tiny run for the imported movie. Sonarr waits for a short quiet period and combines consecutive episode imports from the same series into one History/Logs batch.</p>

      <div class="import-batch-panel">
        <div class="import-batch-copy">
          <strong>Sonarr import queue</strong>
          <span>Every new episode resets the timer. When no further episode arrives during the window, all unique MKVs from that series are processed together.</span>
        </div>
        <label class="stack-field import-batch-window">
          <span>Batch debounce</span>
          <div class="input-suffix"><input type="number" min="5" max="300" class="field automation-setting" data-key="sonarr_import_debounce_seconds" value="${esc(debounce)}"><em>seconds</em></div>
        </label>
      </div>

      <div class="import-fallback-grid">
        <label class="stack-field">
          <span>Fallback lookback</span>
          <div class="input-suffix"><input type="number" min="1" max="120" class="field automation-setting" data-key="import_fallback_window_minutes" value="${esc(fallbackWindow)}"><em>minutes</em></div>
        </label>
        <label class="stack-field">
          <span>Fallback maximum</span>
          <div class="input-suffix"><input type="number" min="1" max="50" class="field automation-setting" data-key="import_fallback_max_files" value="${esc(fallbackMax)}"><em>files</em></div>
        </label>
      </div>
      <div class="run-hint import-fallback-note">Fallback is used only when the webhook does not provide a usable MKV path. SceneNFO then considers only recently modified MKVs inside the affected movie/series folder — never the complete library.</div>
      <div class="import-webhook-endpoints">
        <div><span>Radarr webhook</span><code>/api/webhooks/radarr</code></div>
        <div><span>Sonarr webhook</span><code>/api/webhooks/sonarr</code></div>
      </div>`;
    card.insertBefore(block, actions);
  }

  const originalRenderSettings = typeof renderSettings === 'function' ? renderSettings : null;
  if (originalRenderSettings) {
    renderSettings = async function(...args){
      const result = await originalRenderSettings(...args);
      await enhanceImportAutomation();
      return result;
    };
  }
})();
