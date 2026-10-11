/**
 * Best-effort: clicar botão de download no Google Drive (PT/EN).
 * Não contorna CAPTCHA; apenas UI do Drive na sessão do utilizador.
 */
(function driveDownloadContent() {
  function textMatch(el, patterns) {
    const t = (el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
    return patterns.some((p) => t.includes(p));
  }

  function findDownloadControl() {
    const patterns = ['download', 'fazer download', 'baixar', 'descarregar'];

    const candidates = [
      ...document.querySelectorAll('[aria-label]'),
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('div[role="button"]'),
      ...document.querySelectorAll('a[href*="export"]'),
      ...document.querySelectorAll('a[href*="uc?"]'),
    ];

    for (const el of candidates) {
      if (!textMatch(el, patterns)) continue;
      if (el.offsetParent === null && el.getClientRects().length === 0) continue;
      return el;
    }

    // menu "mais opções" → depois download (segunda passagem pedida pelo background)
    const more = candidates.find((el) =>
      textMatch(el, ['more actions', 'mais ações', 'mais acções', 'more options'])
    );
    if (more) return { el: more, needsMenu: true };

    return null;
  }

  function clickEl(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof el.click === 'function') el.click();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'DRIVE_CLICK_DOWNLOAD') return false;

    (async () => {
      const L = globalThis.__stripperLog;
      try {
        L?.info?.('drive', 'DRIVE_CLICK_DOWNLOAD', { href: location.href.slice(0, 240) });
        await new Promise((r) => setTimeout(r, msg.settleMs || 1200));
        let found = findDownloadControl();
        if (found?.needsMenu) {
          L?.info?.('drive', 'opening more-actions menu');
          clickEl(found.el);
          await new Promise((r) => setTimeout(r, 600));
          found = findDownloadControl();
        }
        const el = found?.el || found;
        if (!el || found?.needsMenu) {
          L?.warn?.('drive', 'Download control not found', {
            href: location.href.slice(0, 240),
            title: document.title,
          });
          sendResponse({
            ok: false,
            error: 'Download control not found on Drive UI',
            url: location.href,
          });
          return;
        }
        L?.info?.('drive', 'clicking download control', {
          tag: el.tagName,
          aria: el.getAttribute?.('aria-label') || null,
          text: (el.textContent || '').trim().slice(0, 80),
        });
        clickEl(el);
        sendResponse({ ok: true, clicked: true, url: location.href });
      } catch (err) {
        L?.error?.('drive', 'DRIVE_CLICK_DOWNLOAD error', { error: err?.message || String(err) });
        sendResponse({ ok: false, error: err?.message || String(err) });
      }
    })();

    return true;
  });
})();
