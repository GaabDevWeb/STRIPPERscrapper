/**
 * Cliente HTTP do bridge local (127.0.0.1 + X-Stripper-Token).
 * Nunca envia cookies/tokens Infnet.
 */

const DEFAULTS = {
  bridgeBaseUrl: 'http://127.0.0.1:8787',
  bridgeToken: '',
};

export async function getBridgeConfig() {
  const data = await chrome.storage.local.get(['bridgeBaseUrl', 'bridgeToken']);
  return {
    bridgeBaseUrl: (data.bridgeBaseUrl || DEFAULTS.bridgeBaseUrl).replace(/\/+$/, ''),
    bridgeToken: data.bridgeToken || '',
  };
}

/** Aceita só loopback (RNF-001 / security hardening). */
export function assertLoopbackBridgeUrl(url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    throw new Error('bridgeBaseUrl inválido');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('bridgeBaseUrl: protocolo inválido');
  }
  const host = (u.hostname || '').toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error('bridgeBaseUrl deve ser 127.0.0.1 ou localhost');
  }
  return u.href.replace(/\/+$/, '');
}

export async function saveBridgeConfig({ bridgeBaseUrl, bridgeToken }) {
  const patch = {};
  if (bridgeBaseUrl != null) {
    patch.bridgeBaseUrl = assertLoopbackBridgeUrl(bridgeBaseUrl);
  }
  if (bridgeToken != null) patch.bridgeToken = String(bridgeToken);
  await chrome.storage.local.set(patch);
  return getBridgeConfig();
}

/**
 * @param {string} path
 * @param {{ method?: string; body?: object|null; auth?: boolean; config?: {bridgeBaseUrl:string;bridgeToken:string} }} [opts]
 */
export async function bridgeFetch(path, opts = {}) {
  const config = opts.config || (await getBridgeConfig());
  const method = opts.method || 'GET';
  const headers = {
    Accept: 'application/json',
  };
  if (opts.body != null) headers['Content-Type'] = 'application/json';
  if (opts.auth !== false && config.bridgeToken) {
    headers['X-Stripper-Token'] = config.bridgeToken;
  }
  const url = `${config.bridgeBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
    });
  } catch (err) {
    const e = new Error(`bridge_network: ${err?.message || String(err)}`);
    e.errorKind = 'network';
    throw e;
  }
  let data = null;
  const text = await res.text();
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text?.slice?.(0, 200) };
  }
  if (!res.ok) {
    const e = new Error(data?.error || data?.reason || `HTTP ${res.status}`);
    e.status = res.status;
    e.errorKind = data?.errorKind || (res.status === 401 ? 'http' : 'http');
    e.body = data;
    throw e;
  }
  return data;
}

export async function healthCheck() {
  return bridgeFetch('/health', { auth: false });
}

export async function authBridge() {
  return bridgeFetch('/v1/auth/bridge', { auth: true });
}

export async function postLessonDiscovery(payload) {
  return bridgeFetch('/v1/discovery/lessons', { method: 'POST', body: payload });
}

export async function postDocumentDiscovery(payload) {
  return bridgeFetch('/v1/discovery/documents', { method: 'POST', body: payload });
}

export async function startJob(payload) {
  return bridgeFetch('/v1/jobs/start', { method: 'POST', body: payload });
}

export async function getJob(runId) {
  return bridgeFetch(`/v1/jobs/${encodeURIComponent(runId)}`, { method: 'GET' });
}

export async function cancelJob(runId) {
  return bridgeFetch(`/v1/jobs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: {} });
}

export async function postArtifact(taskId, payload) {
  return bridgeFetch(`/v1/tasks/${encodeURIComponent(taskId)}/artifact`, {
    method: 'POST',
    body: payload,
  });
}

export async function postEvent(payload) {
  try {
    return await bridgeFetch('/v1/events', { method: 'POST', body: payload });
  } catch {
    return null;
  }
}

export async function getManifestSummary() {
  return bridgeFetch('/v1/manifest/summary', { method: 'GET' });
}
