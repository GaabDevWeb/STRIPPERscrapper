/**
 * Service worker MV3 — router de mensagens, discovery, fila sequencial de downloads, bridge.
 */
import {
  getAuthState,
  setAuthState,
  updateAuthFromUrl,
  AUTH_STATES,
} from './lib/authState.js';
import {
  getBridgeConfig,
  saveBridgeConfig,
  healthCheck,
  authBridge,
  postLessonDiscovery,
  postDocumentDiscovery,
  startJob,
  cancelJob,
  getJob,
  postArtifact,
  postEvent,
  getManifestSummary,
} from './lib/bridgeClient.js';
import { stableTranscriptItemId, stableDocumentItemId } from './lib/stableIds.js';
import { withRetries } from './lib/retry.js';
import { log, getLogs, clearLogs, appendLog } from './lib/logger.js';

const DEFAULT_EXTENSIONS = new Set(['pdf', 'pptx', 'xlsx']);
const INBOX_PREFIX = 'StripperScrapper';
/** Espelha `downloads/documents/` do core no inbox do Chrome. */
const INBOX_DOCUMENTS_DIR = 'documents';
const MAX_ATTEMPTS = 3;

/**
 * Path relativo sob StripperScrapper/, alinhado ao layout ISS (`downloads/`):
 * - lesson → `<Secção>/<Aula>.bin`
 * - document → `documents/<relParts…>/<ficheiro>`
 * @param {object} task
 * @param {string} [fileName]
 */
function inboxRelativeHint(task, fileName) {
  if (task?.type === 'document') {
    const parts = [
      INBOX_DOCUMENTS_DIR,
      ...(Array.isArray(task.metadata?.relParts) ? task.metadata.relParts.map(safeDirName) : []),
      fileName || task.filename || 'file.bin',
    ];
    return parts.filter(Boolean).join('/');
  }
  const section = safeDirName(task?.metadata?.accordionTitle || task?.course || 'aulas');
  const stem = safeDirName(task?.title || 'aula');
  const name = fileName || `${stem}.bin`;
  return `${section}/${name}`;
}

// Side panel disponível ao clicar no ícone (mantém também popup via botão)
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
} catch {
  /* API indisponível */
}

void log.info('bg', 'service worker started');

/** @type {{ cancelled: boolean; running: boolean; runId: string|null; progress: object; queue: any[]; failFast: boolean }} */
const runState = {
  cancelled: false,
  running: false,
  runId: null,
  progress: { completed: 0, skipped: 0, failed: 0, dlq: 0, pending: 0 },
  queue: [],
  failFast: false,
};

function safeDirName(name) {
  const s = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 120);
  return (s || 'pasta').replace(/\s/g, '_');
}

function normalizeListUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    let p = url.pathname.replace(/\/+$/, '') || '/';
    url.pathname = p.endsWith('/') ? p : `${p}/`;
    return url.href;
  } catch {
    return u;
  }
}

function extFromTitle(title, extHint) {
  const t = String(title || '');
  const m = t.match(/\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  if (extHint) return extHint.toLowerCase();
  return '';
}

function extFromDownloadUrl(url) {
  try {
    const u = new URL(url);
    const pathname = decodeURIComponent(u.pathname || '');
    const lastSeg = pathname.split('/').filter(Boolean).pop() || '';
    const m = lastSeg.match(/\.([a-z0-9]{1,12})$/i);
    if (m) return m[1].toLowerCase();
    for (const key of ['filename', 'name', 'file']) {
      const q = u.searchParams.get(key);
      if (q) {
        const m2 = q.match(/\.([a-z0-9]{1,12})$/i);
        if (m2) return m2[1].toLowerCase();
      }
    }
  } catch {
    /* ignore */
  }
  return '';
}

function resolveDocumentFileExt(file) {
  return extFromTitle(file.title, file.extHint) || extFromDownloadUrl(file.downloadUrl);
}

function broadcastProgress() {
  try {
    chrome.runtime
      .sendMessage({ type: 'RUN_PROGRESS', payload: { ...runState.progress, runId: runState.runId, running: runState.running } })
      .catch(() => {});
  } catch {
    /* popup closed */
  }
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

async function ensureContentScripts(tabId, files) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch {
    /* already injected or page blocked */
  }
}

async function openOrNavigate(url, { active = false } = {}) {
  const tab = await chrome.tabs.create({ url, active });
  await waitTabComplete(tab.id);
  return tab.id;
}

function waitTabComplete(tabId, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(async () => {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          clearInterval(timer);
          resolve(tab);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error('tab_navigation_timeout'));
        }
      } catch (e) {
        clearInterval(timer);
        reject(e);
      }
    }, 250);
  });
}

function waitDownloadComplete(downloadId, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(onChanged);
      reject(new Error('download_timeout'));
    }, timeoutMs);

    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChanged);
        resolve({ state: 'complete' });
      } else if (delta.state?.current === 'interrupted') {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(onChanged);
        reject(new Error(`download_interrupted:${delta.error?.current || 'unknown'}`));
      }
    }
    chrome.downloads.onChanged.addListener(onChanged);
  });
}

async function searchDownloadInfo(downloadId) {
  const items = await chrome.downloads.search({ id: downloadId });
  return items[0] || null;
}

function absolutePathOrNull(filename) {
  if (!filename) return null;
  // Chrome por vezes devolve path absoluto; noutros builds só relativo a Downloads.
  if (/^([A-Za-z]:\\|\/)/.test(filename)) return filename;
  return null;
}

/**
 * Normaliza paths do chrome.downloads para o contrato do core:
 * - localPath: absoluto se existir
 * - relativeFilename: StripperScrapper/... (nunca path absoluto)
 * - originalFilename: só o basename
 */
function normalizeDownloadResult(infoFilename, filenameHint) {
  const resolved = infoFilename || filenameHint || null;
  const localPath = absolutePathOrNull(resolved);
  let relativeFilename = null;
  let originalFilename = null;

  if (resolved) {
    const norm = String(resolved).replace(/\\/g, '/');
    originalFilename = norm.split('/').filter(Boolean).pop() || null;
    const marker = `/${INBOX_PREFIX}/`;
    const idx = norm.indexOf(marker);
    if (idx >= 0) {
      relativeFilename = norm.slice(idx + 1); // StripperScrapper/...
    } else if (!localPath) {
      // já era relativo à pasta Downloads
      relativeFilename = norm.replace(/^\/+/, '');
      if (!relativeFilename.startsWith(`${INBOX_PREFIX}/`)) {
        relativeFilename = `${INBOX_PREFIX}/${relativeFilename}`;
      }
    } else if (originalFilename) {
      relativeFilename = `${INBOX_PREFIX}/${originalFilename}`;
    }
  }

  return { localPath, relativeFilename, originalFilename, filename: resolved };
}

async function downloadByUrl(url, filenameHint) {
  const hintClean = filenameHint
    ? String(filenameHint).replace(/^\/+/, '').replace(/^StripperScrapper\//, '')
    : '';
  const filename = hintClean ? `${INBOX_PREFIX}/${hintClean}` : undefined;
  await log.info('download', 'chrome.downloads.download', {
    urlHost: (() => {
      try {
        return new URL(url).host;
      } catch {
        return '?';
      }
    })(),
    filename,
  });
  const downloadId = await chrome.downloads.download({
    url,
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
  await waitDownloadComplete(downloadId);
  const info = await searchDownloadInfo(downloadId);
  const normalized = normalizeDownloadResult(info?.filename || filename, filename);
  await log.info('download', 'download complete', {
    downloadId,
    localPath: normalized.localPath,
    relativeFilename: normalized.relativeFilename,
    originalFilename: normalized.originalFilename,
    state: info?.state,
    error: info?.error,
  });
  return {
    downloadId,
    ...normalized,
  };
}

function extractDriveFileId(task) {
  if (task?.id && String(task.id).startsWith('transcript:gdrv:')) {
    return String(task.id).slice('transcript:gdrv:'.length);
  }
  const href = task?.source_url || task?.download_url || '';
  try {
    const m = String(href).match(/\/file\/d\/([^/]+)/);
    if (m) return m[1];
    const u = new URL(href);
    return u.searchParams.get('id');
  } catch {
    return null;
  }
}

async function downloadLessonViaDrive(task) {
  await log.info('lesson', 'downloadLessonViaDrive start', {
    id: task.id,
    title: task.title,
    accordion: task.metadata?.accordionTitle || null,
    source_url: task.source_url || task.download_url,
  });

  const fileId = extractDriveFileId(task);
  const hint = inboxRelativeHint(task);

  // Primário: download directo pelo ID (HTML novo já traz /file/d/<id>/view)
  // Evita UI frágil do Drive viewer.
  if (fileId) {
    const direct = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
    await log.info('lesson', 'direct Drive export download', { fileId, hint });
    try {
      return await downloadByUrl(direct, hint);
    } catch (e) {
      await log.warn('lesson', 'direct download failed — trying Drive UI click', {
        fileId,
        error: String(e?.message || e),
      });
    }
  }

  const tabId = await openOrNavigate(task.source_url || task.download_url, { active: false });
  try {
    await ensureContentScripts(tabId, ['content/debugLog.js', 'content/driveDownload.js']);
    await new Promise((r) => setTimeout(r, 1500));
    const before = Date.now();
    const clickRes = await sendTabMessage(tabId, { type: 'DRIVE_CLICK_DOWNLOAD', settleMs: 800 }).catch(
      (e) => ({ ok: false, error: String(e?.message || e) })
    );
    await log.info('lesson', 'DRIVE_CLICK_DOWNLOAD result', clickRes);

    const started = await waitForNewDownload(before, 45000).catch((e) => {
      void log.warn('lesson', 'waitForNewDownload failed', { error: String(e?.message || e) });
      return null;
    });
    if (!started) {
      throw new Error(clickRes?.error || 'drive_download_not_started');
    }
    await log.info('lesson', 'download created after Drive click', {
      downloadId: started.id,
      filename: started.filename,
      mime: started.mime,
    });
    await waitDownloadComplete(started.id);
    const info = await searchDownloadInfo(started.id);
    const normalized = normalizeDownloadResult(info?.filename || null, hint);
    return {
      downloadId: started.id,
      ...normalized,
      clickOk: !!clickRes?.ok,
    };
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* ignore */
    }
  }
}

function waitForNewDownload(sinceMs, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      chrome.downloads.onCreated.removeListener(onCreated);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('no_download_created')), timeoutMs);
    function onCreated(item) {
      if (item.startTime && Date.parse(item.startTime) + 2000 < sinceMs) return;
      finish(resolve, item);
    }
    chrome.downloads.onCreated.addListener(onCreated);
    const poll = setInterval(async () => {
      try {
        const items = await chrome.downloads.search({
          startedAfter: sinceMs - 1000,
          limit: 5,
          orderBy: ['-startTime'],
        });
        const hit = items.find((i) => Date.parse(i.startTime) >= sinceMs - 500);
        if (hit) finish(resolve, hit);
      } catch {
        /* ignore poll errors */
      }
    }, 400);
  });
}

async function verifyAuth() {
  const tabs = await chrome.tabs.query({ url: ['https://infnet.online/*', 'https://*.infnet.online/*'] });
  if (!tabs.length) {
    const tabId = await openOrNavigate('https://infnet.online/', { active: true });
    const tab = await chrome.tabs.get(tabId);
    return updateAuthFromUrl(tab.url || '');
  }
  const tab = tabs[0];
  try {
    await ensureContentScripts(tab.id, ['content/infnetAuth.js']);
    const res = await sendTabMessage(tab.id, { type: 'PING_AUTH' });
    return updateAuthFromUrl(res?.url || tab.url || '');
  } catch {
    return updateAuthFromUrl(tab.url || '');
  }
}

async function discoverLessons(classesUrl) {
  await log.info('discover', 'lessons start', { classesUrl });
  const auth = await getAuthState();
  if (auth.status === AUTH_STATES.SESSION_EXPIRED || auth.status === AUTH_STATES.NOT_AUTHENTICATED) {
    throw Object.assign(new Error('Não autenticado'), { errorKind: 'session_expired' });
  }
  const tabId = await openOrNavigate(classesUrl, { active: false });
  try {
    await ensureContentScripts(tabId, [
      'content/debugLog.js',
      'content/infnetAuth.js',
      'content/lessonDiscovery.js',
    ]);
    await new Promise((r) => setTimeout(r, 800));
    const tab = await chrome.tabs.get(tabId);
    await updateAuthFromUrl(tab.url || '');
    if ((tab.url || '').includes('wp-login.php')) {
      await setAuthState({ status: AUTH_STATES.SESSION_EXPIRED, detail: 'Sessão expirada — reautentique' });
      throw Object.assign(new Error('session_expired'), { errorKind: 'session_expired' });
    }
    const res = await sendTabMessage(tabId, { type: 'EXTRACT_LESSONS' });
    if (!res?.ok) {
      if (res?.errorKind === 'session_expired') {
        await setAuthState({ status: AUTH_STATES.SESSION_EXPIRED, detail: res.error });
      }
      throw Object.assign(new Error(res?.error || 'extract_lessons_failed'), {
        errorKind: res?.errorKind || 'html',
      });
    }
    const tasks = (res.items || []).map((row, i) => ({
      type: 'lesson',
      domIndex: i,
      title: row.title || `aula_${i + 1}`,
      source_url: row.href,
      download_url: row.href,
      id: stableTranscriptItemId(row.href),
      course: res.courseName || 'Disciplina',
      metadata: { accordionTitle: row.accordionTitle || '' },
    }));
    const payload = {
      classesUrl: res.classesUrl || classesUrl,
      courseName: res.courseName || 'Disciplina',
      discoveredAt: new Date().toISOString(),
      tasks,
    };
    let bridge = null;
    try {
      bridge = await postLessonDiscovery(payload);
    } catch (err) {
      bridge = { ok: false, error: err.message, offline: true };
    }
    await chrome.storage.local.set({ lastLessonDiscovery: payload });
    await log.info('discover', 'lessons done', {
      count: tasks.length,
      courseName: payload.courseName,
      bridgeOk: !!bridge?.ok,
      bridgeOffline: !!bridge?.offline,
      emptyDiag: res.emptyDiag || null,
    });
    return { payload, bridge, emptyDiag: res.emptyDiag };
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* ignore */
    }
  }
}

async function discoverDocuments(documentsUrl, { maxDepth = 32, extensions = DEFAULT_EXTENSIONS } = {}) {
  await log.info('discover', 'documents start', { documentsUrl, maxDepth });
  const auth = await getAuthState();
  if (auth.status === AUTH_STATES.SESSION_EXPIRED || auth.status === AUTH_STATES.NOT_AUTHENTICATED) {
    throw Object.assign(new Error('Não autenticado'), { errorKind: 'session_expired' });
  }

  const visited = new Set();
  const queue = [{ listUrl: normalizeListUrl(documentsUrl), depth: 0, relParts: [] }];
  const tasks = [];
  const tabId = await openOrNavigate(documentsUrl, { active: false });

  try {
    await ensureContentScripts(tabId, [
      'content/debugLog.js',
      'content/infnetAuth.js',
      'content/documentDiscovery.js',
    ]);

    while (queue.length) {
      if (runState.cancelled) break;
      const job = queue.shift();
      const key = normalizeListUrl(job.listUrl);
      if (visited.has(key)) continue;
      visited.add(key);

      await chrome.tabs.update(tabId, { url: job.listUrl });
      await waitTabComplete(tabId);
      await new Promise((r) => setTimeout(r, 500));
      await ensureContentScripts(tabId, ['content/debugLog.js', 'content/documentDiscovery.js']);

      const tab = await chrome.tabs.get(tabId);
      if ((tab.url || '').includes('wp-login.php')) {
        await setAuthState({
          status: AUTH_STATES.SESSION_EXPIRED,
          detail: 'Sessão expirada durante discovery de documentos',
        });
        throw Object.assign(new Error('session_expired'), { errorKind: 'session_expired' });
      }

      let listing;
      try {
        listing = await sendTabMessage(tabId, { type: 'EXTRACT_DOCUMENT_LISTING' });
      } catch {
        continue;
      }
      if (!listing?.ok) {
        if (listing?.errorKind === 'session_expired') {
          await setAuthState({ status: AUTH_STATES.SESSION_EXPIRED, detail: listing.error });
          throw Object.assign(new Error('session_expired'), { errorKind: 'session_expired' });
        }
        continue;
      }

      const { folders, files } = listing;
      if (job.depth < maxDepth) {
        for (const f of folders) {
          const childKey = normalizeListUrl(f.listUrl);
          if (visited.has(childKey)) continue;
          queue.push({
            listUrl: childKey,
            depth: job.depth + 1,
            relParts: [...job.relParts, safeDirName(f.label)],
          });
        }
      }

      for (const file of files) {
        const ext = resolveDocumentFileExt(file);
        if (!extensions.has(ext)) continue;
        const id = stableDocumentItemId(file.downloadUrl);
        const baseName = String(file.title || 'documento').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '').trim() || 'documento';
        const filename = baseName.toLowerCase().endsWith(`.${ext}`) ? baseName : `${baseName}.${ext}`;
        tasks.push({
          type: 'document',
          id,
          path: job.relParts.join('/'),
          filename,
          extension: ext,
          source_url: file.downloadUrl.split('#')[0],
          metadata: { relParts: [...job.relParts], listUrl: job.listUrl },
        });
      }
    }

    const payload = {
      documentsUrl,
      discoveredAt: new Date().toISOString(),
      tasks,
    };
    let bridge = null;
    try {
      bridge = await postDocumentDiscovery(payload);
    } catch (err) {
      bridge = { ok: false, error: err.message, offline: true };
    }
    await chrome.storage.local.set({ lastDocumentDiscovery: payload });
    await log.info('discover', 'documents done', {
      count: tasks.length,
      bridgeOk: !!bridge?.ok,
      bridgeOffline: !!bridge?.offline,
    });
    return { payload, bridge };
  } finally {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* ignore */
    }
  }
}

async function notifyArtifact(task, dl, attempt) {
  const originalFilename =
    dl.originalFilename ||
    task.filename ||
    (dl.relativeFilename && String(dl.relativeFilename).split('/').pop()) ||
    null;
  // filename para o core = basename limpo (nunca path absoluto)
  const filenameForCore =
    originalFilename ||
    (task.type === 'document' ? task.filename : null) ||
    null;
  const relativeFilename =
    dl.relativeFilename && !/^([A-Za-z]:\\|\/)/.test(dl.relativeFilename)
      ? dl.relativeFilename
      : filenameForCore
        ? `${INBOX_PREFIX}/${inboxRelativeHint(task, filenameForCore)}`
        : null;

  const body = {
    id: task.id,
    type: task.type,
    localPath: dl.localPath || null,
    filename: filenameForCore || relativeFilename,
    downloadId: dl.downloadId ?? null,
    source_url: task.source_url || task.download_url,
    course: task.course || null,
    title: task.title || task.filename || null,
    extension: task.extension || null,
    metadata: {
      ...(task.metadata || {}),
      inboxPrefix: INBOX_PREFIX,
      relativeFilename,
      originalFilename,
    },
    attempt,
  };
  try {
    await log.info('bridge', 'POST artifact', {
      id: task.id,
      type: task.type,
      attempt,
      localPath: body.localPath,
      filename: body.filename,
      relativeFilename: body.metadata?.relativeFilename,
    });
    const res = await postArtifact(task.id, body);
    await log.info('bridge', 'artifact response', {
      id: task.id,
      result: res?.result,
      errorKind: res?.errorKind,
      reason: res?.reason,
      retryable: res?.retryable,
      dlq: res?.dlq,
      artifactRelPath: res?.artifactRelPath,
    });
    return res;
  } catch (err) {
    await log.error('bridge', 'artifact failed', {
      id: task.id,
      error: String(err?.message || err),
      errorKind: err.errorKind || err.body?.errorKind,
      status: err.status,
    });
    if (err.errorKind === 'session_expired' || err.body?.errorKind === 'session_expired') {
      await setAuthState({
        status: AUTH_STATES.SESSION_EXPIRED,
        detail: 'Core reportou session_expired no artefacto',
      });
    }
    throw err;
  }
}

function isRetryableDownloadError(err) {
  const kind = err?.errorKind || err?.body?.errorKind || '';
  if (kind === 'session_expired') return false;
  if (kind === 'cancelled') return false;
  // HTML genérico / integrity / rede / timeout → retry até MAX_ATTEMPTS
  return true;
}

async function processDownloadQueue(tasks, { failFast = false, runId = null } = {}) {
  runState.running = true;
  runState.cancelled = false;
  runState.failFast = failFast;
  runState.runId = runId;
  runState.queue = tasks.slice();
  runState.progress = {
    completed: 0,
    skipped: 0,
    failed: 0,
    dlq: 0,
    pending: tasks.length,
  };
  broadcastProgress();
  await log.info('queue', 'processDownloadQueue start', {
    runId,
    total: tasks.length,
    failFast,
    types: {
      lesson: tasks.filter((t) => t.type === 'lesson').length,
      document: tasks.filter((t) => t.type === 'document').length,
    },
  });

  for (const task of tasks) {
    if (runState.cancelled) break;
    const startedAt = new Date().toISOString();
    let lastAttempt = 1;
    try {
      const result = await withRetries(
        async ({ attempt }) => {
          lastAttempt = attempt;
          if (runState.cancelled) {
            const e = new Error('cancelled');
            e.errorKind = 'cancelled';
            throw e;
          }
          await postEvent({
            runId,
            taskId: task.id,
            type: task.type,
            phase: attempt === 1 ? 'download_start' : 'retry',
            attempt,
            startedAt,
            result: null,
          });

          let dl;
          if (task.type === 'lesson') {
            dl = await downloadLessonViaDrive(task);
          } else {
            dl = await downloadByUrl(task.source_url, inboxRelativeHint(task));
          }

          const res = await notifyArtifact(task, dl, attempt);
          if (res?.result === 'error') {
            const e = new Error(res.reason || 'artifact error');
            e.errorKind = res.errorKind || 'unknown';
            e.body = res;
            e.retryable = res.retryable !== false && res.errorKind !== 'session_expired';
            throw e;
          }
          return res;
        },
        {
          retries: MAX_ATTEMPTS,
          backoffMs: [400, 1200, 2500],
          isRetryable: (err) => {
            if (err?.retryable === false) return false;
            return isRetryableDownloadError(err);
          },
          onRetry: async ({ attempt, delayMs, error }) => {
            await postEvent({
              runId,
              taskId: task.id,
              type: task.type,
              phase: 'retry',
              attempt,
              startedAt,
              result: 'error',
              errorKind: error?.errorKind || 'unknown',
              reason: `retry in ${delayMs}ms`,
            });
          },
        }
      );

      if (result?.result === 'skipped') runState.progress.skipped += 1;
      else runState.progress.completed += 1;

      await log.info('queue', 'task ok', {
        id: task.id,
        type: task.type,
        result: result?.result || 'ok',
        attempt: lastAttempt,
      });

      await postEvent({
        runId,
        taskId: task.id,
        type: task.type,
        phase: 'download_end',
        attempt: lastAttempt,
        startedAt,
        endedAt: new Date().toISOString(),
        result: result?.result || 'ok',
        errorKind: result?.errorKind || null,
      });
    } catch (err) {
      const kind = err.errorKind || err.body?.errorKind || 'unknown';
      await log.error('queue', 'task failed', {
        id: task.id,
        type: task.type,
        attempt: lastAttempt,
        errorKind: kind,
        error: String(err?.message || err),
      });
      runState.progress.failed += 1;
      // DLQ só após esgotar tentativas (ou erro permanente); session_expired pausa sem DLQ
      if (kind !== 'session_expired' && kind !== 'cancelled' && lastAttempt >= MAX_ATTEMPTS) {
        runState.progress.dlq += 1;
      }
      await postEvent({
        runId,
        taskId: task.id,
        type: task.type,
        phase: 'download_end',
        attempt: lastAttempt,
        startedAt,
        endedAt: new Date().toISOString(),
        result: 'error',
        errorKind: kind,
        reason: String(err.message || err).slice(0, 200),
      });
      if (kind === 'session_expired') {
        runState.running = false;
        broadcastProgress();
        return { paused_auth: true, progress: { ...runState.progress } };
      }
      if (failFast) {
        runState.running = false;
        broadcastProgress();
        return { failed: true, progress: { ...runState.progress }, error: err.message };
      }
    } finally {
      runState.progress.pending = Math.max(0, runState.progress.pending - 1);
      broadcastProgress();
    }
  }

  runState.running = false;
  broadcastProgress();
  const summary = {
    completed: !runState.cancelled,
    cancelled: runState.cancelled,
    progress: { ...runState.progress },
  };
  await log.info('queue', 'processDownloadQueue end', summary);
  return summary;
}

async function getSettings() {
  const data = await chrome.storage.local.get([
    'classesUrl',
    'documentsUrl',
    'scope',
    'mode',
    'ignoreManifest',
    'failFast',
    'bridgeBaseUrl',
    'bridgeToken',
  ]);
  const bridge = await getBridgeConfig();
  return {
    classesUrl: data.classesUrl || '',
    documentsUrl: data.documentsUrl || '',
    scope: data.scope || 'all',
    mode: data.mode || 'discover_and_download',
    ignoreManifest: !!data.ignoreManifest,
    failFast: !!data.failFast,
    ...bridge,
  };
}

async function saveSettings(patch) {
  const allowed = [
    'classesUrl',
    'documentsUrl',
    'scope',
    'mode',
    'ignoreManifest',
    'failFast',
  ];
  const toSet = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) toSet[k] = patch[k];
  }
  if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
  if (patch.bridgeBaseUrl !== undefined || patch.bridgeToken !== undefined) {
    await saveBridgeConfig({
      bridgeBaseUrl: patch.bridgeBaseUrl,
      bridgeToken: patch.bridgeToken,
    });
  }
  return getSettings();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'APPEND_LOG': {
        const p = msg.payload || {};
        await appendLog(p.level || 'info', p.source || 'content', p.message || '', p.data);
        sendResponse({ ok: true });
        break;
      }
      case 'GET_LOGS': {
        sendResponse({ ok: true, logs: await getLogs() });
        break;
      }
      case 'CLEAR_LOGS': {
        await clearLogs();
        sendResponse({ ok: true });
        break;
      }
      case 'OPEN_SIDEPANEL': {
        try {
          const win = await chrome.windows.getCurrent();
          await chrome.sidePanel.open({ windowId: win.id });
          await log.info('ui', 'side panel opened');
          sendResponse({ ok: true });
        } catch (e) {
          await log.error('ui', 'side panel open failed', { error: String(e?.message || e) });
          sendResponse({ ok: false, error: String(e?.message || e) });
        }
        break;
      }
      case 'AUTH_URL_OBSERVED': {
        const state = await updateAuthFromUrl(msg.payload?.url || '', {
          userActivity: msg.payload?.userActivity,
        });
        sendResponse({ ok: true, state });
        break;
      }
      case 'GET_AUTH_STATE': {
        sendResponse({ ok: true, state: await getAuthState() });
        break;
      }
      case 'VERIFY_AUTH': {
        sendResponse({ ok: true, state: await verifyAuth() });
        break;
      }
      case 'GET_SETTINGS': {
        sendResponse({ ok: true, settings: await getSettings() });
        break;
      }
      case 'SAVE_SETTINGS': {
        sendResponse({ ok: true, settings: await saveSettings(msg.payload || {}) });
        break;
      }
      case 'BRIDGE_HEALTH': {
        try {
          const health = await healthCheck();
          let auth = null;
          try {
            auth = await authBridge();
          } catch (e) {
            auth = { ok: false, error: e.message };
          }
          sendResponse({ ok: true, health, auth });
        } catch (e) {
          sendResponse({ ok: false, error: e.message, errorKind: e.errorKind });
        }
        break;
      }
      case 'DISCOVER': {
        try {
          const settings = await getSettings();
          const scope = msg.payload?.scope || settings.scope || 'all';
          const out = { lessons: null, documents: null };
          if (scope === 'lessons' || scope === 'all') {
            if (!settings.classesUrl) throw new Error('CLASSES_URL em falta');
            out.lessons = await discoverLessons(settings.classesUrl);
          }
          if (scope === 'docs' || scope === 'all') {
            if (!settings.documentsUrl) throw new Error('DOCUMENTS_URL em falta');
            out.documents = await discoverDocuments(settings.documentsUrl);
          }
          sendResponse({ ok: true, ...out });
        } catch (e) {
          sendResponse({ ok: false, error: e.message, errorKind: e.errorKind });
        }
        break;
      }
      case 'START_DOWNLOAD': {
        try {
          if (runState.running) {
            sendResponse({ ok: false, error: 'Já existe um run em curso' });
            break;
          }
          const settings = await getSettings();
          const scope = msg.payload?.scope || settings.scope || 'all';
          const mode = msg.payload?.mode || settings.mode || 'discover_and_download';
          const ignoreManifest = msg.payload?.ignoreManifest ?? settings.ignoreManifest;
          const failFast = msg.payload?.failFast ?? settings.failFast;
          await log.info('ui', 'START_DOWNLOAD', { scope, mode, ignoreManifest, failFast });

          // Discovery se necessário
          let lessons = null;
          let documents = null;
          if (scope === 'lessons' || scope === 'all') {
            if (!settings.classesUrl) throw new Error('CLASSES_URL em falta');
            lessons = await discoverLessons(settings.classesUrl);
          }
          if (scope === 'docs' || scope === 'all') {
            if (!settings.documentsUrl) throw new Error('DOCUMENTS_URL em falta');
            documents = await discoverDocuments(settings.documentsUrl);
          }

          if (mode === 'discover_only') {
            await log.warn('ui', 'START_DOWNLOAD em discover_only — NENHUM download será feito', {
              lessons: lessons?.payload?.tasks?.length ?? 0,
              docs: documents?.payload?.tasks?.length ?? 0,
            });
            sendResponse({ ok: true, mode, lessons, documents });
            break;
          }

          let runId = null;
          try {
            const started = await startJob({
              scope,
              mode: 'discover_and_download',
              ignoreManifest: !!ignoreManifest,
              failFast: !!failFast,
              limit: null,
            });
            runId = started?.runId || null;
            await log.info('bridge', 'job started', { runId });
          } catch (e) {
            runId = `local-${Date.now()}`;
            await log.warn('bridge', 'startJob failed — using local runId', {
              runId,
              error: String(e?.message || e),
            });
          }

          const tasks = [];
          if (lessons?.payload?.tasks) tasks.push(...lessons.payload.tasks);
          if (documents?.payload?.tasks) tasks.push(...documents.payload.tasks);

          // process async; respond immediately with runId
          sendResponse({ ok: true, runId, queued: tasks.length });
          processDownloadQueue(tasks, { failFast: !!failFast, runId }).then(async (result) => {
            if (runId && !String(runId).startsWith('local-')) {
              try {
                await getJob(runId);
              } catch {
                /* optional */
              }
            }
            try {
              chrome.runtime
                .sendMessage({ type: 'RUN_FINISHED', payload: result })
                .catch(() => {});
            } catch {
              /* ignore */
            }
          });
        } catch (e) {
          sendResponse({ ok: false, error: e.message, errorKind: e.errorKind });
        }
        break;
      }
      case 'CANCEL_RUN': {
        runState.cancelled = true;
        if (runState.runId && !String(runState.runId).startsWith('local-')) {
          try {
            await cancelJob(runState.runId);
          } catch {
            /* ignore */
          }
        }
        sendResponse({ ok: true, progress: { ...runState.progress } });
        break;
      }
      case 'GET_PROGRESS': {
        sendResponse({
          ok: true,
          progress: { ...runState.progress },
          running: runState.running,
          runId: runState.runId,
        });
        break;
      }
      case 'MANIFEST_SUMMARY': {
        try {
          sendResponse({ ok: true, summary: await getManifestSummary() });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown_message', type: msg?.type });
    }
  })();

  return true; // async
});

// Auth hints from tab updates (session expired mid-flight)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== 'complete') return;
  const url = changeInfo.url || tab.url || '';
  if (!/infnet\.online/i.test(url) && !url.includes('wp-login.php')) return;
  updateAuthFromUrl(url).catch(() => {});
});
