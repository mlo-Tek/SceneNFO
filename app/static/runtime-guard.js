(() => {
  function showError(reason) {
    const message = reason instanceof Error ? reason.message : String(reason || 'Unknown error');
    const status = document.querySelector('#scan-status');
    const run = document.querySelector('#run-scan');
    const stop = document.querySelector('#stop-scan');
    const active = document.querySelector('#active-job-count');

    if (status) status.textContent = `Error: ${message}`;
    if (run) run.disabled = false;
    if (stop) stop.disabled = true;
    if (active) active.textContent = '0 ACTIVE';

    if (typeof toast === 'function') toast(`Scan failed: ${message}`, 'error');
    console.error('[SceneNFO]', reason);
  }

  window.addEventListener('unhandledrejection', event => {
    showError(event.reason);
  });

  window.addEventListener('error', event => {
    if (event.error) showError(event.error);
  });
})();
