/**
 * Observa URL/navegação Infnet e reporta estado de auth ao background.
 * Não lê nem envia cookies/tokens/passwords.
 */
(function infnetAuthContent() {
  function report(userActivity) {
    try {
      chrome.runtime.sendMessage({
        type: 'AUTH_URL_OBSERVED',
        payload: {
          url: location.href,
          userActivity: !!userActivity,
        },
      });
    } catch {
      /* extension context invalidated */
    }
  }

  report(false);

  let lastHref = location.href;
  const checkHref = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      report(false);
    }
  };

  const mo = new MutationObserver(checkHref);
  mo.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', () => report(false));
  window.addEventListener('hashchange', () => report(false));

  // actividade do utilizador na página de login → AUTHENTICATING
  if (location.href.includes('wp-login.php')) {
    const markActivity = () => report(true);
    document.addEventListener('input', markActivity, { once: true, capture: true });
    document.addEventListener('keydown', markActivity, { once: true, capture: true });
    document.addEventListener('click', markActivity, { once: true, capture: true });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'PING_AUTH') {
      sendResponse({ ok: true, url: location.href });
      return true;
    }
    if (msg?.type === 'GET_PAGE_URL') {
      sendResponse({ url: location.href });
      return true;
    }
    return false;
  });
})();
