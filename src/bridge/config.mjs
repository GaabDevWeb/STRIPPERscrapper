/**
 * Configuração do Core Bridge (loopback).
 */
import os from 'os';
import path from 'path';
import { projectRoot as defaultProjectRoot } from '../utils/infnetShared.mjs';

/**
 * Pasta onde a extensão deixa ficheiros via chrome.downloads (spike ID 9).
 * Preferência: STRIPPER_INBOX_DIR → ~/Downloads → temp_downloads/extension-inbox
 * @param {string} projectRoot
 * @param {string} [override]
 */
function expandHome(p) {
  return String(p || '').replace(/^~(?=$|[/\\])/, os.homedir());
}

export function resolveInboxDir(projectRoot, override) {
  const raw = String(override || '').trim() || (process.env.STRIPPER_INBOX_DIR || '').trim();
  if (raw) return path.resolve(expandHome(raw));
  // fallback documentado no spike; projectRoot reservado para fallback de projecto
  void projectRoot;
  return path.join(os.homedir(), 'Downloads');
}

/**
 * @param {object} [overrides]
 * @returns {{
 *   projectRoot: string,
 *   downloadsDir: string,
 *   documentsDir: string,
 *   inboxDir: string,
 *   host: string,
 *   port: number,
 *   tokenPath: string,
 *   maxBodyBytes: number,
 *   bridgeVersion: number,
 * }}
 */
export function loadBridgeConfig(overrides = {}) {
  const projectRoot = path.resolve(
    overrides.projectRoot || process.env.STRIPPER_PROJECT_ROOT || defaultProjectRoot
  );
  const downloadsDir = path.resolve(
    expandHome(
      overrides.downloadsDir ||
        process.env.STRIPPER_DOWNLOADS_DIR ||
        path.join(projectRoot, 'downloads')
    )
  );
  const portRaw = overrides.port ?? process.env.STRIPPER_BRIDGE_PORT ?? process.env.PORT ?? 8787;
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT inválido: ${portRaw}`);
  }

  const inboxDir = resolveInboxDir(
    projectRoot,
    overrides.inboxDir || process.env.STRIPPER_INBOX_DIR || ''
  );

  return {
    projectRoot,
    downloadsDir,
    documentsDir: path.join(downloadsDir, 'documents'),
    inboxDir,
    host: '127.0.0.1',
    port,
    tokenPath: path.resolve(
      overrides.tokenPath || path.join(projectRoot, '.bridge-token')
    ),
    maxBodyBytes: Number(overrides.maxBodyBytes || process.env.STRIPPER_MAX_BODY_BYTES) || 1_048_576,
    bridgeVersion: 1,
  };
}
