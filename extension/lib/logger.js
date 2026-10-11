/**
 * Logger central da extensão — ring buffer em chrome.storage.local.
 * Nunca regista token, password, cookies ou localStorage.
 */

const STORAGE_KEY = 'debugLogs';
const MAX_ENTRIES = 2500;

const SENSITIVE_KEY =
  /pass(word)?|token|cookie|authorization|localstorage|secret|pwd|faculdade_pass/i;

function sanitizeValue(v, depth = 0) {
  if (v == null) return v;
  if (typeof v === 'string') {
    if (v.length > 2000) return `${v.slice(0, 2000)}…[truncated ${v.length}]`;
    return v;
  }
  if (typeof v !== 'object' || depth > 4) return String(v);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitizeValue(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    out[k] = sanitizeValue(val, depth + 1);
  }
  return out;
}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} source
 * @param {string} message
 * @param {unknown} [data]
 */
export async function appendLog(level, source, message, data) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    t: Date.now(),
    iso: new Date().toISOString(),
    level: level || 'info',
    source: String(source || 'ext'),
    message: String(message || ''),
    data: data === undefined ? undefined : sanitizeValue(data),
  };

  let logs = [];
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    logs = Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  } catch {
    logs = [];
  }
  logs.push(entry);
  if (logs.length > MAX_ENTRIES) logs = logs.slice(logs.length - MAX_ENTRIES);
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: logs });
  } catch {
    /* quota — drop half */
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: logs.slice(-Math.floor(MAX_ENTRIES / 2)) });
    } catch {
      /* ignore */
    }
  }

  try {
    chrome.runtime.sendMessage({ type: 'LOG_BROADCAST', payload: entry }).catch(() => {});
  } catch {
    /* no listeners */
  }

  return entry;
}

export async function getLogs() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(stored[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
  } catch {
    return [];
  }
}

export async function clearLogs() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  try {
    chrome.runtime.sendMessage({ type: 'LOG_CLEARED' }).catch(() => {});
  } catch {
    /* ignore */
  }
}

export function formatLogsPlain(logs) {
  return (logs || [])
    .map((e) => {
      const data =
        e.data !== undefined ? ` | ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}` : '';
      return `${e.iso} [${String(e.level).toUpperCase()}] [${e.source}] ${e.message}${data}`;
    })
    .join('\n');
}

/** Atalhos */
export const log = {
  debug: (source, msg, data) => appendLog('debug', source, msg, data),
  info: (source, msg, data) => appendLog('info', source, msg, data),
  warn: (source, msg, data) => appendLog('warn', source, msg, data),
  error: (source, msg, data) => appendLog('error', source, msg, data),
};
