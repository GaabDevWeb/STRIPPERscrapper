/**
 * Auth state machine (RF-001).
 * Estados: NOT_AUTHENTICATED | AUTHENTICATING | AUTHENTICATED | SESSION_EXPIRED | ERROR
 * Nunca armazena passwords / cookies Infnet.
 */

export const AUTH_STATES = Object.freeze({
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  AUTHENTICATING: 'AUTHENTICATING',
  AUTHENTICATED: 'AUTHENTICATED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  ERROR: 'ERROR',
});

const STORAGE_KEY = 'authState';

/**
 * @param {string} url
 * @param {{ hadAuthBefore?: boolean; userActivity?: boolean }} [hints]
 */
export function inferAuthFromUrl(url, hints = {}) {
  const u = String(url || '');
  const onLogin = u.includes('wp-login.php');
  const onInfnet = /https?:\/\/([^/]*\.)?infnet\.online\//i.test(u);

  if (onLogin) {
    if (hints.hadAuthBefore) return AUTH_STATES.SESSION_EXPIRED;
    if (hints.userActivity) return AUTH_STATES.AUTHENTICATING;
    return AUTH_STATES.NOT_AUTHENTICATED;
  }
  if (onInfnet) return AUTH_STATES.AUTHENTICATED;
  return null;
}

export async function getAuthState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return (
    data[STORAGE_KEY] || {
      status: AUTH_STATES.NOT_AUTHENTICATED,
      checkedAt: null,
      detail: null,
      hadAuthBefore: false,
    }
  );
}

/**
 * @param {{ status: string; detail?: string|null; hadAuthBefore?: boolean }} patch
 */
export async function setAuthState(patch) {
  const prev = await getAuthState();
  const next = {
    status: patch.status ?? prev.status,
    checkedAt: new Date().toISOString(),
    detail: patch.detail !== undefined ? patch.detail : prev.detail,
    hadAuthBefore:
      patch.hadAuthBefore !== undefined
        ? patch.hadAuthBefore
        : patch.status === AUTH_STATES.AUTHENTICATED
          ? true
          : prev.hadAuthBefore,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });
  try {
    chrome.runtime.sendMessage({ type: 'AUTH_STATE_CHANGED', payload: next }).catch(() => {});
  } catch {
    /* popup may be closed */
  }
  return next;
}

/**
 * Actualiza estado a partir de URL observada (content script / tabs).
 * @param {string} url
 * @param {{ userActivity?: boolean }} [opts]
 */
export async function updateAuthFromUrl(url, opts = {}) {
  const prev = await getAuthState();
  const inferred = inferAuthFromUrl(url, {
    hadAuthBefore: prev.hadAuthBefore || prev.status === AUTH_STATES.AUTHENTICATED,
    userActivity: opts.userActivity,
  });
  if (!inferred) return prev;
  if (inferred === prev.status && prev.checkedAt) {
    // refresh timestamp lightly for AUTHENTICATED polls
    if (inferred === AUTH_STATES.AUTHENTICATED) {
      return setAuthState({ status: inferred, detail: 'Sessão Infnet activa' });
    }
    return prev;
  }
  const detailMap = {
    [AUTH_STATES.NOT_AUTHENTICATED]: 'Página de login detectada — autentique manualmente',
    [AUTH_STATES.AUTHENTICATING]: 'Login em curso (CAPTCHA/manual)',
    [AUTH_STATES.AUTHENTICATED]: 'Sessão Infnet activa',
    [AUTH_STATES.SESSION_EXPIRED]: 'Sessão expirada — reautentique no site',
    [AUTH_STATES.ERROR]: 'Erro ao verificar autenticação',
  };
  return setAuthState({ status: inferred, detail: detailMap[inferred] || null });
}
