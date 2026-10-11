/**
 * Helper de log para content scripts → painel lateral.
 */
(function stripperDebugLog() {
  function send(level, source, message, data) {
    try {
      chrome.runtime.sendMessage({
        type: 'APPEND_LOG',
        payload: { level, source, message, data },
      });
    } catch {
      /* ignore */
    }
  }
  globalThis.__stripperLog = {
    debug: (s, m, d) => send('debug', s, m, d),
    info: (s, m, d) => send('info', s, m, d),
    warn: (s, m, d) => send('warn', s, m, d),
    error: (s, m, d) => send('error', s, m, d),
  };
  send('debug', 'content', 'debugLog ready', { href: location.href.slice(0, 200) });
})();
