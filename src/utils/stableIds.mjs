/**
 * IDs estáveis de artefactos (transcript / document).
 * Extraído de downloadManifest.mjs — algoritmos idênticos (não alterar).
 */
import crypto from 'crypto';

/**
 * @param {string} url
 * @returns {string}
 */
export function normalizeUrlForId(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return String(url || '');
  }
}

/**
 * @param {string} prefix
 * @param {string} url
 * @returns {string}
 */
export function shaUrlKey(prefix, url) {
  const h = crypto.createHash('sha256').update(normalizeUrlForId(url)).digest('hex');
  return `${prefix}${h.slice(0, 48)}`;
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
