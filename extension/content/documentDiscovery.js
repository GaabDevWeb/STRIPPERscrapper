/**
 * Helpers injectáveis de listing BuddyPress — selectors de documentScraper.js extractListingScript
 * + gentleScrollForLazyContent.
 */
(function documentDiscoveryContent() {
  function extractListingScript() {
    const FOLDER_PATH = '/documents/folders/';
    const folders = [];
    const files = [];

    for (const row of document.querySelectorAll('.media-folder_items.ac-folder-list')) {
      let nav = row.querySelector(`a.media-folder_name[href*="${FOLDER_PATH}"]`);
      if (!nav?.href) {
        nav = row.querySelector('a.media-folder_name[href*="documents/folders"]');
      }
      if (!nav?.href) {
        nav = row.querySelector('a.media-folder_name[href*="/documents/"][href*="folder"]');
      }
      if (!nav?.href) continue;
      const span = nav.querySelector('span');
      const label = (span?.textContent || nav.textContent || '').replace(/\s+/g, ' ').trim();
      if (!label) continue;
      folders.push({ label, listUrl: nav.href.split('#')[0] });
    }

    for (const row of document.querySelectorAll('.media-folder_items.ac-document-list')) {
      const dl = row.querySelector('li.download_file a[href]');
      if (!dl?.href) continue;
      const titleA = row.querySelector('a.media-folder_name');
      const dataTitle = titleA?.getAttribute('data-document-title')?.trim();
      const span = titleA?.querySelector('span');
      const fromSpan = span?.textContent?.trim();
      const title = dataTitle || fromSpan || titleA?.textContent?.trim() || 'documento';
      const extAttr = (titleA?.getAttribute('data-extension') || '').toLowerCase();
      files.push({
        downloadUrl: dl.href.split('#')[0],
        title,
        extHint: extAttr,
      });
    }

    return { folders, files };
  }

  async function gentleScrollForLazyContent() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const h = Math.max(document.body?.scrollHeight || 0, 8000);
    const steps = Math.min(12, Math.ceil(h / 1200));
    for (let i = 0; i < steps; i++) {
      window.scrollBy(0, 1200);
      await sleep(350);
    }
    window.scrollTo(0, 0);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'EXTRACT_DOCUMENT_LISTING') return false;

    (async () => {
      try {
        if (location.href.includes('wp-login.php')) {
          sendResponse({
            ok: false,
            errorKind: 'session_expired',
            error: 'Login page — sessão não autenticada',
          });
          return;
        }
        await gentleScrollForLazyContent();
        // breve espera pós-scroll (lazy)
        await new Promise((r) => setTimeout(r, 200));
        const listing = extractListingScript();
        globalThis.__stripperLog?.info?.('docs', 'EXTRACT_DOCUMENT_LISTING', {
          href: location.href.slice(0, 240),
          folders: listing.folders.length,
          files: listing.files.length,
        });
        sendResponse({
          ok: true,
          listUrl: location.href,
          folders: listing.folders,
          files: listing.files,
        });
      } catch (err) {
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();

    return true; // async sendResponse
  });
})();
