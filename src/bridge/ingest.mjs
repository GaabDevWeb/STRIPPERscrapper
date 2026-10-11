/**
 * Ingestão de artefactos: validateBinaryFile + toMarkdown + manifest.
 * Aceita localPath (ex. chrome.downloads) — sem CAPTCHA / sem session.json.
 */
import fs from 'fs/promises';
import path from 'path';
import {
  ensureDir,
  safeDirName,
  safeFileName,
  fileExists,
} from '../utils/infnetShared.mjs';
import {
  resolveManifestRootAndPath,
  isItemCompleted,
  markArtifactCompletedIfPresent,
  markArtifactError,
} from '../utils/downloadManifest.mjs';
import { validateBinaryFile, safeUnlink } from '../utils/integrity.mjs';
import { toMarkdown } from '../utils/lessonMarkdown.mjs';

/** Alinhado a `withRetries` do core / extensão (RF-008). */
export const MAX_ARTIFACT_ATTEMPTS = 3;

/**
 * DLQ no manifest só após esgotar tentativas.
 * `session_expired` nunca vai a DLQ na 1.ª detecção — o item fica pending para reauth.
 * @param {object} opts
 * @param {number} opts.attempt
 * @param {string} [opts.errorKind]
 * @param {() => Promise<void>} opts.mark
 */
async function maybeMarkDlq({ attempt, errorKind, mark }) {
  if (errorKind === 'session_expired') return { dlq: false, retryable: false };
  if (attempt < MAX_ARTIFACT_ATTEMPTS) return { dlq: false, retryable: true };
  await mark().catch(() => {});
  return { dlq: true, retryable: false };
}

/**
 * @param {string} filePath
 * @returns {Promise<{ isHtml: boolean, looksLikeLogin: boolean, head: string }>}
 */
export async function sniffHtmlSession(filePath) {
  const fh = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(512);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.slice(0, bytesRead).toString('utf8').trimStart().toLowerCase();
    const isHtml =
      head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head');
    const looksLikeLogin =
      isHtml &&
      (head.includes('wp-login') ||
        head.includes('user_login') ||
        head.includes('name="log"') ||
        head.includes('name="pwd"') ||
        head.includes('id="user_pass"'));
    return { isHtml, looksLikeLogin, head: head.slice(0, 200) };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Classifica HTML / sessão a partir do ficheiro local (antes de mark completed).
 * @param {string} filePath
 * @returns {Promise<'session_expired' | 'html' | null>}
 */
export async function classifyHtmlArtifact(filePath) {
  try {
    const { isHtml, looksLikeLogin } = await sniffHtmlSession(filePath);
    if (!isHtml) return null;
    return looksLikeLogin ? 'session_expired' : 'html';
  } catch {
    return null;
  }
}

async function uniqueDestPath(dir, baseName) {
  let dest = path.join(dir, baseName);
  if (!(await fileExists(dest))) return dest;
  const ext = path.extname(baseName);
  const stem = ext ? baseName.slice(0, -ext.length) : baseName;
  for (let i = 2; i < 9999; i++) {
    const candidate = path.join(dir, `${stem}_${i}${ext}`);
    if (!(await fileExists(candidate))) return candidate;
  }
  return path.join(dir, `${stem}_${Date.now()}${ext}`);
}

function posixRel(fromRoot, absolutePath) {
  return path.relative(fromRoot, absolutePath).split(path.sep).join('/');
}

/** Evita `safeFileName('/home/.../Aula.pdf')` → `home...Aula.pdf`. */
function pickArtifactBaseName(body, localPath) {
  const candidates = [
    body.metadata?.originalFilename,
    body.title && body.extension ? `${body.title}.${body.extension}` : null,
    body.filename,
    body.metadata?.relativeFilename,
    localPath,
  ];
  for (const c of candidates) {
    if (!c) continue;
    const base = path.basename(String(c).replace(/\\/g, '/'));
    if (!base || base === '.' || base === '..') continue;
    // rejeitar "nomes" que ainda parecem path colapsado
    if (base.length > 180) continue;
    return safeFileName(base);
  }
  return safeFileName(body.title || 'arquivo');
}

/**
 * Resolve ficheiro a partir de localPath absoluto OU inbox + filename
 * (contrato extensão quando Chrome não expõe path absoluto — spike ID 9).
 *
 * @param {object} cfg
 * @param {object} body
 * @returns {Promise<{ localPath: string } | { error: object }>}
 */
export async function resolveArtifactSourcePath(cfg, body) {
  const direct = String(body.localPath || '').trim();
  if (direct) {
    if (await fileExists(direct)) return { localPath: direct };
    return {
      error: {
        httpStatus: 400,
        body: {
          ok: false,
          result: 'error',
          errorKind: 'unknown',
          reason: 'localPath inexistente',
          artifactRelPath: null,
          markdownRelPath: null,
        },
      },
    };
  }

  const rel =
    String(body.filename || body.metadata?.relativeFilename || '').trim() ||
    '';
  if (!rel) {
    return {
      error: {
        httpStatus: 400,
        body: {
          ok: false,
          result: 'error',
          errorKind: 'unknown',
          reason: 'localPath ou filename/relativeFilename são obrigatórios',
          artifactRelPath: null,
          markdownRelPath: null,
        },
      },
    };
  }

  const inboxDir = path.resolve(
    cfg.inboxDir || path.join(cfg.projectRoot || process.cwd(), 'temp_downloads', 'extension-inbox')
  );
  const inboxRoot = inboxDir.endsWith(path.sep) ? inboxDir : inboxDir + path.sep;
  const candidates = [
    path.resolve(inboxDir, rel),
    path.resolve(inboxDir, path.basename(rel)),
    path.resolve(inboxDir, 'StripperScrapper', path.basename(rel)),
    // layout ISS: StripperScrapper/documents/...
    path.resolve(inboxDir, 'StripperScrapper', 'documents', path.basename(rel)),
  ];
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (!normalized.startsWith(inboxRoot) && normalized !== inboxDir) continue;
    if (await fileExists(normalized)) return { localPath: normalized };
  }

  return {
    error: {
      httpStatus: 400,
      body: {
        ok: false,
        result: 'error',
        errorKind: 'unknown',
        reason: `artefacto não encontrado no inbox (${inboxDir}) para filename=${rel}`,
        artifactRelPath: null,
        markdownRelPath: null,
      },
    },
  };
}

export async function processArtifact(cfg, body, taskIdFromPath) {
  const id = String(body.id || taskIdFromPath || '').trim();
  const type = body.type === 'document' ? 'document' : body.type === 'lesson' ? 'lesson' : null;
  const attempt = Number(body.attempt) > 0 ? Number(body.attempt) : 1;

  if (!id || !type) {
    return {
      httpStatus: 400,
      body: {
        ok: false,
        result: 'error',
        errorKind: 'unknown',
        reason: 'id e type são obrigatórios',
        artifactRelPath: null,
        markdownRelPath: null,
      },
    };
  }

  const resolved = await resolveArtifactSourcePath(cfg, body);
  if (resolved.error) return resolved.error;
  const localPath = resolved.localPath;

  const downloadsDir = cfg.downloadsDir;
  const documentsDir = cfg.documentsDir || path.join(downloadsDir, 'documents');
  const { manifestPath, manifestRoot } = resolveManifestRootAndPath(
    downloadsDir,
    type === 'document' ? documentsDir : downloadsDir
  );

  if (
    !body.ignoreManifest &&
    (await isItemCompleted(manifestPath, id, { verifyArtifact: true, manifestRoot }))
  ) {
    return {
      httpStatus: 200,
      body: {
        ok: true,
        result: 'skipped',
        artifactRelPath: null,
        markdownRelPath: null,
        errorKind: null,
      },
    };
  }

  const htmlKind = await classifyHtmlArtifact(localPath);
  if (htmlKind === 'session_expired' || htmlKind === 'html') {
    // Inegociável: NÃO marcar completed; session_expired → 409; DLQ só se html após max attempts
    const reason =
      htmlKind === 'session_expired'
        ? 'artifact looks like HTML login page'
        : 'artifact looks like HTML';
    const dlqInfo = await maybeMarkDlq({
      attempt,
      errorKind: htmlKind,
      mark: () =>
        markArtifactError({
          manifestPath,
          manifestRoot,
          itemId: id,
          kind: type === 'lesson' ? 'transcript' : 'document',
          sourceUrl: body.source_url || '',
          reason,
          attempts: attempt,
          errorKind: htmlKind,
        }),
    }).catch(() => ({ dlq: false, retryable: htmlKind !== 'session_expired' }));

    return {
      httpStatus: htmlKind === 'session_expired' ? 409 : 200,
      body: {
        ok: false,
        result: 'error',
        artifactRelPath: null,
        markdownRelPath: null,
        errorKind: htmlKind,
        reason,
        retryable: dlqInfo.retryable,
        dlq: dlqInfo.dlq,
      },
    };
  }

  let dest = '';
  let mdWritten = '';

  try {
    const srcExt = path.extname(localPath) || (body.extension ? `.${body.extension}` : '.bin');
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};

    if (type === 'lesson') {
      const sectionLabel =
        metadata.accordionTitle ||
        metadata.section ||
        body.course ||
        'Disciplina';
      const disciplineDir = path.join(
        downloadsDir,
        safeDirName(sectionLabel, { maxLen: 80, fallback: 'Disciplina' })
      );
      await ensureDir(disciplineDir);
      const base = pickArtifactBaseName(
        { ...body, filename: body.filename || path.basename(localPath) },
        localPath
      );
      const stem = base.replace(/\.[a-z0-9]+$/i, '') || safeFileName(body.title || 'aula');
      const fileName = /\.[a-z0-9]+$/i.test(base) ? base : `${stem}${srcExt}`;
      dest = await uniqueDestPath(disciplineDir, fileName);
      await fs.copyFile(localPath, dest);

      await validateBinaryFile({ filePath: dest });

      const meta = {
        title: body.title || base,
        source_url: body.source_url || '',
        course: body.course || sectionLabel,
        downloaded_at: new Date().toISOString(),
      };
      mdWritten = await toMarkdown(dest, meta);

      await markArtifactCompletedIfPresent({
        manifestPath,
        manifestRoot,
        itemId: id,
        kind: 'transcript',
        sourceUrl: body.source_url || '',
        artifactAbsPath: dest,
        markdownAbsPath: mdWritten,
      });

      return {
        httpStatus: 200,
        body: {
          ok: true,
          result: 'completed',
          artifactRelPath: posixRel(manifestRoot, dest),
          markdownRelPath: posixRel(manifestRoot, mdWritten),
          errorKind: null,
        },
      };
    }

    // document
    const relParts = Array.isArray(metadata.relParts)
      ? metadata.relParts.map((p) => safeDirName(String(p)))
      : String(body.path || '')
          .split(/[/\\]+/)
          .filter(Boolean)
          .map((p) => safeDirName(p));
    const baseDir =
      relParts.length === 0 ? documentsDir : path.join(documentsDir, ...relParts);
    await ensureDir(baseDir);
    let base = pickArtifactBaseName(body, localPath);
    if (!/\.[a-z0-9]+$/i.test(base)) {
      const ext = (body.extension || srcExt.replace(/^\./, '') || 'bin').replace(/^\./, '');
      base = `${base}.${ext}`;
    }
    dest = await uniqueDestPath(baseDir, base);
    await fs.copyFile(localPath, dest);
    await validateBinaryFile({ filePath: dest });

    await markArtifactCompletedIfPresent({
      manifestPath,
      manifestRoot,
      itemId: id,
      kind: 'document',
      sourceUrl: body.source_url || '',
      artifactAbsPath: dest,
    });

    return {
      httpStatus: 200,
      body: {
        ok: true,
        result: 'completed',
        artifactRelPath: posixRel(manifestRoot, dest),
        markdownRelPath: null,
        errorKind: null,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    let errorKind = 'unknown';
    if (msg.includes('parece HTML') || msg.includes('parece html')) {
      // validateBinaryFile path — re-sniff for session
      const kind = (await classifyHtmlArtifact(dest || localPath)) || 'html';
      errorKind = kind;
      await safeUnlink(dest);
      await safeUnlink(mdWritten);
      const reason =
        kind === 'session_expired' ? 'artifact looks like HTML login page' : msg.slice(0, 400);
      const dlqInfo = await maybeMarkDlq({
        attempt,
        errorKind: kind,
        mark: () =>
          markArtifactError({
            manifestPath,
            manifestRoot,
            itemId: id,
            kind: type === 'lesson' ? 'transcript' : 'document',
            sourceUrl: body.source_url || '',
            reason,
            attempts: attempt,
            errorKind: kind,
          }),
      }).catch(() => ({ dlq: false, retryable: kind !== 'session_expired' }));
      return {
        httpStatus: kind === 'session_expired' ? 409 : 200,
        body: {
          ok: false,
          result: 'error',
          artifactRelPath: null,
          markdownRelPath: null,
          errorKind: kind,
          reason,
          retryable: dlqInfo.retryable,
          dlq: dlqInfo.dlq,
        },
      };
    }
    if (msg.includes('integrity:')) errorKind = 'integrity';
    if (msg.includes('timeout') || msg.includes('timed out')) errorKind = 'timeout';

    await safeUnlink(dest);
    await safeUnlink(mdWritten);
    const reason = msg.slice(0, 400);
    const dlqInfo = await maybeMarkDlq({
      attempt,
      errorKind,
      mark: () =>
        markArtifactError({
          manifestPath,
          manifestRoot,
          itemId: id,
          kind: type === 'lesson' ? 'transcript' : 'document',
          sourceUrl: body.source_url || '',
          reason,
          attempts: attempt,
          errorKind,
          lastError: err,
        }),
    }).catch(() => ({ dlq: false, retryable: true }));

    return {
      httpStatus: 200,
      body: {
        ok: false,
        result: 'error',
        artifactRelPath: null,
        markdownRelPath: null,
        errorKind,
        reason,
        retryable: dlqInfo.retryable,
        dlq: dlqInfo.dlq,
      },
    };
  }
}
