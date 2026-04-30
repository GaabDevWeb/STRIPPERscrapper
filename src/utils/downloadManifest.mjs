/**
 * Registo persistente de artefactos descarregados (idempotência / retomada).
 * Ficheiro JSON na raiz da árvore de downloads (ex.: `downloads/manifest.json`).
 */
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileExists } from './infnetShared.mjs';

export const MANIFEST_VERSION = 1;

/** @typedef {'transcript' | 'document'} ManifestKind */

/**
 * @typedef {object} ManifestEntry
 * @property {ManifestKind} kind
 * @property {'completed' | 'error'} status
 * @property {string} sourceUrl
 * @property {string} [artifactRelPath] — relativo a `manifestRoot` (POSIX)
 * @property {string} [markdownRelPath] — transcrições: .md adjacente
 * @property {string} [completedAt] — ISO-8601
 * @property {string} [errorAt] — ISO-8601
 * @property {string} [errorKind] — classificação estável (ex.: network|timeout|http|integrity|html|unknown)
 * @property {string} [reason] — mensagem curta auditável
 * @property {number} [attempts]
 * @property {string} [lastErrorAt] — ISO-8601 (última tentativa)
 * @property {string} [lastError] — mensagem (sanitizada) do último erro
 */

/**
 * @typedef {object} ManifestDoc
 * @property {number} version
 * @property {string} updatedAt
 * @property {Record<string, ManifestEntry>} entries
 */

function posixRel(fromRoot, absolutePath) {
  const rel = path.relative(fromRoot, absolutePath);
  return rel.split(path.sep).join('/');
}

/** Caminho absoluto a partir da raiz do manifest e de um relativo POSIX guardado no JSON. */
function absFromManifestRel(manifestRoot, posixRelPath) {
  const parts = String(posixRelPath || '')
    .split(/[/\\]+/)
    .filter((p) => p && p !== '.');
  if (!parts.length) return '';
  return path.normalize(path.join(manifestRoot, ...parts));
}

function normalizeUrlForId(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return String(url || '');
  }
}

function shaUrlKey(prefix, url) {
  const h = crypto.createHash('sha256').update(normalizeUrlForId(url)).digest('hex');
  return `${prefix}${h.slice(0, 48)}`;
}

/**
 * ID estável para ligação de transcrição (tipicamente Google Drive).
 * @param {string} href
 */
export function stableTranscriptItemId(href) {
  const id = extractGoogleDriveFileId(href);
  if (id) return `transcript:gdrv:${id}`;
  return shaUrlKey('transcript:url:', href);
}

/**
 * ID estável para URL de download BuddyPress / documentos.
 * @param {string} downloadUrl
 */
export function stableDocumentItemId(downloadUrl) {
  const fromPath = extractBuddyPressDocumentId(downloadUrl);
  if (fromPath) return `document:bp:${fromPath}`;
  return shaUrlKey('document:url:', downloadUrl);
}

/**
 * @param {string} url
 * @returns {string | null}
 */
export function extractGoogleDriveFileId(url) {
  try {
    const u = new URL(url);
    const host = u.hostname || '';
    const p = u.pathname || '';

    const fileD = p.match(/\/file\/d\/([^/]+)/);
    if (fileD) return fileD[1];

    if (host.includes('drive.google.com')) {
      const id = u.searchParams.get('id');
      if (id) return id;
    }

    const docD = p.match(/\/document\/d\/([^/]+)/);
    if (docD) return docD[1];
    const sheetD = p.match(/\/spreadsheets\/d\/([^/]+)/);
    if (sheetD) return sheetD[1];
    const presD = p.match(/\/presentation\/d\/([^/]+)/);
    if (presD) return presD[1];

    return null;
  } catch {
    return null;
  }
}

/**
 * @param {string} downloadUrl
 * @returns {string | null}
 */
export function extractBuddyPressDocumentId(downloadUrl) {
  try {
    const u = new URL(downloadUrl);
    const q =
      u.searchParams.get('document_id') ||
      u.searchParams.get('document-id') ||
      u.searchParams.get('document');
    if (q && /^\d+$/.test(q)) return q;

    const p = u.pathname || '';
    let m = p.match(/\/documents?\/(\d+)\b/i);
    if (m) return m[1];
    m = p.match(/\/document\/(\d+)\b/i);
    if (m) return m[1];
    m = p.match(/\/(\d+)\/download\/?$/i);
    if (m) return m[1];
    return null;
  } catch {
    return null;
  }
}

/**
 * Onde gravar o manifest e qual a raiz para caminhos relativos nos `entries`.
 * Documentos sob `downloads/...` partilham `downloads/manifest.json`.
 *
 * @param {string} downloadsDir — pasta `downloads` do stripper
 * @param {string} outputDir — pasta raiz da árvore de documentos (pode ser `downloads/documents`)
 */
export function resolveManifestRootAndPath(downloadsDir, outputDir) {
  const resolvedDownloads = path.resolve(downloadsDir);
  const resolvedOut = path.resolve(outputDir);
  if (
    resolvedOut === resolvedDownloads ||
    resolvedOut.startsWith(resolvedDownloads + path.sep)
  ) {
    return {
      manifestRoot: resolvedDownloads,
      manifestPath: path.join(resolvedDownloads, 'manifest.json'),
    };
  }
  return {
    manifestRoot: resolvedOut,
    manifestPath: path.join(resolvedOut, 'manifest.json'),
  };
}

/** @returns {Promise<ManifestDoc>} */
export async function loadManifest(manifestPath) {
  try {
    const raw = await fs.readFile(manifestPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return emptyManifest();
    const entries =
      data.entries && typeof data.entries === 'object' ? data.entries : {};
    return {
      version: Number(data.version) || MANIFEST_VERSION,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
      entries,
    };
  } catch {
    return emptyManifest();
  }
}

function emptyManifest() {
  return { version: MANIFEST_VERSION, updatedAt: '', entries: {} };
}

async function atomicWriteJson(filePath, obj) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(obj, null, 2);
  await fs.writeFile(tmp, payload, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (e) {
    const code = /** @type {NodeJS.ErrnoException} */ (e).code;
    if (code === 'EPERM' || code === 'EEXIST' || code === 'EBUSY') {
      await fs.copyFile(tmp, filePath);
      await fs.unlink(tmp).catch(() => {});
    } else {
      throw e;
    }
  }
}

/** Lock por path de manifest (vários workers / processos). */
async function acquireManifestLock(manifestPath, opts = {}) {
  const lockPath = `${manifestPath}.queue.lock`;
  const staleMs = opts.staleMs ?? 300_000;
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      await fh.writeFile(String(process.pid), 'utf8');
      return { fh, lockPath };
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === 'EEXIST') {
        let st = null;
        try {
          st = await fs.stat(lockPath);
        } catch {
          /* lock removido entre-tanto */
        }
        if (st && Date.now() - st.mtimeMs > staleMs) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 150));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Timeout de lock do manifest: ${lockPath}`);
}

/** @param {{ fh: import('fs/promises').FileHandle; lockPath: string }} h */
async function releaseManifestLock(h) {
  await h.fh.close().catch(() => {});
  await fs.unlink(h.lockPath).catch(() => {});
}

/**
 * Fila de gravações por path de manifest (evita corrupção com updates em série).
 * @type {Map<string, Promise<void>>}
 */
const writeChains = new Map();

/**
 * @param {string} manifestPath
 * @param {(doc: ManifestDoc) => ManifestDoc | void} mutator — recebe cópia com entries clonados; pode mutar e retornar doc ou void
 */
async function updateManifest(manifestPath, mutator) {
  const prev = writeChains.get(manifestPath) || Promise.resolve();
  const next = prev.then(() => doUpdate());
  writeChains.set(manifestPath, next.catch(() => {}));
  await next;

  async function doUpdate() {
    const lock = await acquireManifestLock(manifestPath);
    try {
      const current = await loadManifest(manifestPath);
      const doc = {
        version: current.version,
        updatedAt: current.updatedAt,
        entries: { ...current.entries },
      };
      const out = mutator(doc) || doc;
      out.version = MANIFEST_VERSION;
      out.updatedAt = new Date().toISOString();
      await atomicWriteJson(manifestPath, out);
    } finally {
      await releaseManifestLock(lock);
    }
  }
}

/**
 * @param {string} manifestPath
 * @param {string} itemId
 * @param {{ verifyArtifact?: boolean; manifestRoot?: string }} [opts] — com `verifyArtifact` + `manifestRoot`, exige ficheiros no disco (manifest obsoleto apagação manual).
 */
export async function isItemCompleted(manifestPath, itemId, opts = {}) {
  const doc = await loadManifest(manifestPath);
  const e = doc.entries[itemId];
  if (!e || e.status !== 'completed') return false;
  if (opts.verifyArtifact && opts.manifestRoot) {
    const art = absFromManifestRel(opts.manifestRoot, e.artifactRelPath);
    if (!art || !(await fileExists(art))) return false;
    if (e.kind === 'transcript' && e.markdownRelPath) {
      const md = absFromManifestRel(opts.manifestRoot, e.markdownRelPath);
      if (!md || !(await fileExists(md))) return false;
    }
  }
  return true;
}

/**
 * Verifica ficheiros no disco e só então grava manifest (integridade).
 *
 * @param {object} opts
 * @param {string} opts.manifestPath
 * @param {string} opts.manifestRoot
 * @param {string} opts.itemId
 * @param {ManifestKind} opts.kind
 * @param {string} opts.sourceUrl
 * @param {string} opts.artifactAbsPath
 * @param {string} [opts.markdownAbsPath]
 */
export async function markArtifactCompletedIfPresent(opts) {
  const {
    manifestPath,
    manifestRoot,
    itemId,
    kind,
    sourceUrl,
    artifactAbsPath,
    markdownAbsPath,
  } = opts;

  if (!(await fileExists(artifactAbsPath))) {
    throw new Error('manifest: artefacto final inexistente após processamento');
  }
  if (markdownAbsPath && !(await fileExists(markdownAbsPath))) {
    throw new Error('manifest: markdown final inexistente após processamento');
  }

  const artifactRelPath = posixRel(manifestRoot, artifactAbsPath);
  const markdownRelPath = markdownAbsPath
    ? posixRel(manifestRoot, markdownAbsPath)
    : undefined;

  await updateManifest(manifestPath, (doc) => {
    /** @type {ManifestEntry} */
    const entry = {
      kind,
      status: 'completed',
      sourceUrl: normalizeUrlForId(sourceUrl),
      artifactRelPath,
      completedAt: new Date().toISOString(),
    };
    if (markdownRelPath) entry.markdownRelPath = markdownRelPath;
    doc.entries[itemId] = entry;
  });
}

function stringifyError(err) {
  if (!err) return '';
  if (err instanceof Error) {
    // evita stacks gigantes e mantém auditável
    const msg = err.message || String(err);
    return msg.slice(0, 1600);
  }
  return String(err).slice(0, 1600);
}

/**
 * Dead-letter: regista erro final após esgotar tentativas.
 *
 * @param {object} opts
 * @param {string} opts.manifestPath
 * @param {string} opts.manifestRoot
 * @param {string} opts.itemId
 * @param {ManifestKind} opts.kind
 * @param {string} opts.sourceUrl
 * @param {string} opts.reason
 * @param {number} opts.attempts
 * @param {string} [opts.errorKind]
 * @param {unknown} [opts.lastError]
 * @param {string} [opts.artifactAbsPath]
 * @param {string} [opts.markdownAbsPath]
 */
export async function markArtifactError(opts) {
  const {
    manifestPath,
    manifestRoot,
    itemId,
    kind,
    sourceUrl,
    reason,
    attempts,
    errorKind,
    lastError,
    artifactAbsPath,
    markdownAbsPath,
  } = opts;

  const artifactRelPath = artifactAbsPath ? posixRel(manifestRoot, artifactAbsPath) : undefined;
  const markdownRelPath = markdownAbsPath
    ? posixRel(manifestRoot, markdownAbsPath)
    : undefined;

  const now = new Date().toISOString();
  await updateManifest(manifestPath, (doc) => {
    /** @type {ManifestEntry} */
    const entry = {
      kind,
      status: 'error',
      sourceUrl: normalizeUrlForId(sourceUrl),
      reason: String(reason || '').slice(0, 1200),
      attempts: Number(attempts) || 0,
      errorAt: now,
      lastErrorAt: now,
      lastError: stringifyError(lastError),
    };
    if (artifactRelPath) entry.artifactRelPath = artifactRelPath;
    if (markdownRelPath) entry.markdownRelPath = markdownRelPath;
    if (errorKind) entry.errorKind = String(errorKind).slice(0, 120);
    doc.entries[itemId] = entry;
  });
}
