/**
 * Painel lateral de debug — lê logs de chrome.storage (não depende só do SW).
 */

const STORAGE_KEY = 'debugLogs';
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

const $ = (id) => document.getElementById(id);

/** @type {Array<object>} */
let allLogs = [];

function passesFilter(entry) {
  const minLevel = $('levelFilter').value;
  if (minLevel !== 'all' && minLevel !== 'debug') {
    const need = LEVEL_RANK[minLevel] ?? 0;
    const have = LEVEL_RANK[entry.level] ?? 0;
    if (have < need) return false;
  }
  const q = ($('textFilter').value || '').trim().toLowerCase();
  if (!q) return true;
  const hay = `${entry.message || ''} ${entry.source || ''} ${entry.level || ''} ${
    entry.data != null ? JSON.stringify(entry.data) : ''
  }`.toLowerCase();
  return hay.includes(q);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function render() {
  const view = $('logView');
  const filtered = allLogs.filter(passesFilter);
  $('statusBar').textContent = `${filtered.length} visíveis · ${allLogs.length} total · painel OK`;

  if (!filtered.length) {
    view.textContent =
      allLogs.length === 0
        ? 'Sem logs ainda.\n\n1) Clica Atualizar\n2) No popup: Discover ou Start download\n3) Os logs aparecem aqui automaticamente.'
        : 'Nenhum log corresponde ao filtro.';
    return;
  }

  const lines = filtered.map((e) => {
    const dataStr =
      e.data !== undefined
        ? typeof e.data === 'string'
          ? e.data
          : JSON.stringify(e.data)
        : '';
    const level = String(e.level || 'info').toUpperCase();
    return (
      `<div class="line level-${escapeHtml(e.level || 'info')}">` +
      `<span class="meta">${escapeHtml(e.iso || '')}</span> ` +
      `<span class="msg">[${escapeHtml(level)}]</span> ` +
      `<span class="src">[${escapeHtml(e.source || '')}]</span> ` +
      `<span class="msg">${escapeHtml(e.message || '')}</span>` +
      (dataStr ? ` <span class="data">${escapeHtml(dataStr)}</span>` : '') +
      `</div>`
    );
  });
  view.innerHTML = lines.join('');

  if ($('autoScroll').checked) {
    view.scrollTop = view.scrollHeight;
  }
}

async function loadFromStorage() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    allLogs = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  } catch (e) {
    allLogs = [
      {
        iso: new Date().toISOString(),
        level: 'error',
        source: 'sidepanel',
        message: `Falha a ler storage: ${e?.message || e}`,
      },
    ];
  }
  render();
}

async function pingBackground() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          resolve({ ok: false, error: err.message });
          return;
        }
        resolve(response || { ok: false });
      });
    } catch (e) {
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

async function reload() {
  $('statusBar').textContent = 'A carregar…';
  // 1) storage directo (fiável)
  await loadFromStorage();
  // 2) pedir ao SW (pode acordar o worker e sincronizar)
  const r = await pingBackground();
  if (r.ok && Array.isArray(r.logs)) {
    allLogs = r.logs;
    render();
  } else if (!r.ok) {
    $('statusBar').textContent = `${allLogs.length} total · SW: ${r.error || 'offline'} (a usar storage)`;
  }
}

function toPlainText() {
  return allLogs
    .filter(passesFilter)
    .map((e) => {
      const data =
        e.data !== undefined
          ? ` | ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`
          : '';
      return `${e.iso} [${String(e.level).toUpperCase()}] [${e.source}] ${e.message}${data}`;
    })
    .join('\n');
}

function showToast(msg) {
  let el = document.getElementById('copyToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'copyToast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1600);
}

$('btnRefresh').addEventListener('click', () => reload());
$('levelFilter').addEventListener('change', () => render());
$('textFilter').addEventListener('input', () => render());

$('btnClear').addEventListener('click', async () => {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  try {
    chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
  } catch {
    /* ignore */
  }
  allLogs = [];
  render();
});

$('btnCopy').addEventListener('click', async () => {
  const text = toPlainText() || '(sem logs)';
  try {
    await navigator.clipboard.writeText(text);
    showToast('Logs copiados');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    showToast('Logs copiados');
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'LOG_BROADCAST' && msg.payload) {
    allLogs.push(msg.payload);
    if (allLogs.length > 2500) allLogs = allLogs.slice(-2500);
    render();
  }
  if (msg?.type === 'LOG_CLEARED') {
    allLogs = [];
    render();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[STORAGE_KEY]) return;
  const next = changes[STORAGE_KEY].newValue;
  allLogs = Array.isArray(next) ? next : [];
  render();
});

// marca de vida no painel
(async () => {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const logs = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    logs.push({
      id: `panel-${Date.now()}`,
      t: Date.now(),
      iso: new Date().toISOString(),
      level: 'info',
      source: 'sidepanel',
      message: 'Painel de logs aberto e a escutar',
    });
    await chrome.storage.local.set({ [STORAGE_KEY]: logs.slice(-2500) });
  } catch {
    /* ignore */
  }
  await reload();
})();
