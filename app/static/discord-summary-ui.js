(() => {
  const settingValue = (settings, key, fallback='') => {
    const value = settings?.[key];
    return typeof value === 'object' ? (value.value || fallback) : (value ?? fallback);
  };

  const dayOptions = [
    ['mon','Monday'], ['tue','Tuesday'], ['wed','Wednesday'], ['thu','Thursday'],
    ['fri','Friday'], ['sat','Saturday'], ['sun','Sunday'],
  ];

  async function saveDiscordSettings(section){
    const values = {};
    section.querySelectorAll('[data-discord-setting]').forEach(input => {
      values[input.dataset.discordSetting] = input.value;
    });
    return api('/api/integrations/discord/settings', {
      method: 'PUT',
      body: JSON.stringify({values}),
    });
  }

  async function loadPreview(section){
    const node = section.querySelector('#discord-weekly-preview');
    if (!node) return;
    try {
      const data = await api('/api/integrations/discord/preview');
      const s = data.stats || {};
      node.innerHTML = `
        <span><strong>${Number(s.total || 0)}</strong> downloads</span>
        <span><strong>${Number(s.movies || 0)}</strong> movies</span>
        <span><strong>${Number(s.tv || 0)}</strong> TV episodes</span>
        <span>${Number(s.movies_upgrades || 0) + Number(s.tv_upgrades || 0)} upgrades</span>`;
    } catch (_) {
      node.textContent = 'Preview unavailable';
    }
  }

  async function enhanceDiscordSummary(){
    if (currentView !== 'settings') return;
    const root = document.querySelector('#content');
    if (!root || root.querySelector('.discord-weekly-section')) return;

    let settings = {};
    try { settings = await api('/api/settings'); } catch (_) {}

    const enabled = settingValue(settings, 'discord_weekly_enabled', 'false');
    const webhook = settingValue(settings, 'discord_weekly_webhook_url', '');
    const day = settingValue(settings, 'discord_weekly_day', 'sun');
    const time = settingValue(settings, 'discord_weekly_time', '20:00');
    const timezone = settingValue(settings, 'discord_weekly_timezone', 'Europe/Berlin');
    const includeNfo = settingValue(settings, 'discord_weekly_include_nfo', 'true');
    const sendEmpty = settingValue(settings, 'discord_weekly_send_empty', 'true');

    const section = document.createElement('section');
    section.className = 'settings-section discord-weekly-section';
    section.innerHTML = `
      <div class="discord-weekly-head">
        <div>
          <h2>Discord weekly summary</h2>
          <p>Weekly overview of actual Radarr and Sonarr media imports. Manual scans and scheduled SceneNFO scans are not counted as downloads.</p>
        </div>
        <span class="pill info">WEEKLY</span>
      </div>

      <div class="discord-weekly-grid">
        <label class="stack-field">
          <span>Status</span>
          <select data-discord-setting="discord_weekly_enabled">
            <option value="true" ${enabled === 'true' ? 'selected' : ''}>Enabled</option>
            <option value="false" ${enabled !== 'true' ? 'selected' : ''}>Disabled</option>
          </select>
        </label>

        <label class="stack-field discord-webhook-field">
          <span>Discord webhook URL</span>
          <input type="password" class="field" data-discord-setting="discord_weekly_webhook_url" value="${esc(webhook)}" placeholder="https://discord.com/api/webhooks/...">
        </label>

        <label class="stack-field">
          <span>Weekday</span>
          <select data-discord-setting="discord_weekly_day">
            ${dayOptions.map(([value,label]) => `<option value="${value}" ${day === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>

        <label class="stack-field">
          <span>Time</span>
          <input type="time" class="field" data-discord-setting="discord_weekly_time" value="${esc(time)}">
        </label>

        <label class="stack-field">
          <span>Timezone</span>
          <input class="field" data-discord-setting="discord_weekly_timezone" value="${esc(timezone)}" placeholder="Europe/Berlin">
        </label>

        <label class="stack-field">
          <span>NFO statistics</span>
          <select data-discord-setting="discord_weekly_include_nfo">
            <option value="true" ${includeNfo === 'true' ? 'selected' : ''}>Include</option>
            <option value="false" ${includeNfo !== 'true' ? 'selected' : ''}>Hide</option>
          </select>
        </label>

        <label class="stack-field">
          <span>If there were 0 downloads</span>
          <select data-discord-setting="discord_weekly_send_empty">
            <option value="true" ${sendEmpty === 'true' ? 'selected' : ''}>Send summary anyway</option>
            <option value="false" ${sendEmpty !== 'true' ? 'selected' : ''}>Do not send</option>
          </select>
        </label>
      </div>

      <div class="discord-weekly-preview-wrap">
        <span class="discord-preview-label">Last 7 days</span>
        <div id="discord-weekly-preview" class="discord-weekly-preview">Loading preview…</div>
      </div>

      <div class="run-hint">
        Downloads are counted from Radarr/Sonarr import and upgrade events. A Sonarr season-pack batch counts each imported episode once. The summary covers the previous 7 days at the moment it is sent.
      </div>

      <div class="editor-actions discord-weekly-actions">
        <button class="btn secondary" type="button" id="discord-save">Save Discord settings</button>
        <button class="btn primary" type="button" id="discord-test">Send test</button>
        <span class="muted" id="discord-status"></span>
      </div>`;

    root.appendChild(section);
    loadPreview(section);

    const saveButton = section.querySelector('#discord-save');
    const testButton = section.querySelector('#discord-test');
    const status = section.querySelector('#discord-status');

    saveButton.onclick = async () => {
      saveButton.disabled = true;
      status.textContent = 'Saving…';
      try {
        await saveDiscordSettings(section);
        status.textContent = 'Saved';
        toast('Discord weekly summary saved', 'success');
        await loadPreview(section);
      } catch (error) {
        status.textContent = String(error.message || error);
        toast('Could not save Discord settings', 'warning');
      } finally {
        saveButton.disabled = false;
      }
    };

    testButton.onclick = async () => {
      testButton.disabled = true;
      status.textContent = 'Sending test…';
      try {
        await saveDiscordSettings(section);
        const result = await api('/api/integrations/discord/test', {method:'POST'});
        const total = Number(result?.stats?.total || 0);
        status.textContent = `Test sent · ${total} downloads in preview`;
        toast('Discord test message sent', 'success');
        await loadPreview(section);
      } catch (error) {
        status.textContent = String(error.message || error);
        toast('Discord test failed', 'warning');
      } finally {
        testButton.disabled = false;
      }
    };
  }

  const originalRenderSettings = typeof renderSettings === 'function' ? renderSettings : null;
  if (originalRenderSettings) {
    renderSettings = async function(...args){
      const result = await originalRenderSettings(...args);
      await enhanceDiscordSummary();
      return result;
    };
  }
})();
