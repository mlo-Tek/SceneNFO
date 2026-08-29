(() => {
  const LABEL = 'last browser-only download';

  function browserMetaBlocks(root = document) {
    return [...root.querySelectorAll?.('.item-meta') || []].filter(block =>
      block.querySelector('span')?.textContent.trim().toLowerCase() === LABEL
    );
  }

  function dedupeBrowserMeta(root = document) {
    const blocks = browserMetaBlocks(root);
    if (!blocks.length) return;

    const primary = blocks[0];
    primary.classList.add('browser-source-meta');
    blocks.slice(1).forEach(block => block.remove());
  }

  dedupeBrowserMeta();

  const observer = new MutationObserver(() => dedupeBrowserMeta());
  observer.observe(document.body, {childList: true, subtree: true});
})();
