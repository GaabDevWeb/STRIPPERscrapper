/**
 * Scraping recursivo da secção BuddyPress "Documentos" (infnet.online).
 * — Sem cliques em dropdowns: URLs estáticas de `li.download_file a` e pastas via `a.media-folder_name`.
 * — Navegação: apenas page.goto (sessão/cookies no Puppeteer).
 * — Download: fetch no Node com cookies da página (streaming + limite de tamanho).
 */
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { finished } from 'stream/promises';
import { Readable } from 'stream';
import {
  projectRoot,
  ensureDir,
  fileExists,
  printChromeHelp,
  ensureAuthenticated,
  safeDirName,
  safeFileName,
} from '../utils/infnetShared.mjs';
import {
  stableDocumentItemId,
  resolveManifestRootAndPath,
  isItemCompleted,
  markArtifactCompletedIfPresent,
  markArtifactError,
} from '../utils/downloadManifest.mjs';
import { launchBrowser } from '../utils/browser.mjs';
import { makeTaggedLoggers } from '../utils/workerLog.mjs';
import { withRetries } from '../utils/retry.mjs';
import { validateBinaryFile, safeUnlink } from '../utils/integrity.mjs';

const DEFAULT_DOCUMENTS_URL =
  'https://infnet.online/grupos/fundamentos-do-processamento-de-dados-26e1-26e2-93422564/documents/';

const DEFAULT_EXTENSIONS = new Set(['pdf', 'pptx', 'xlsx']);

/** @param {string[]} [args] */
export function parseDocumentArgs(args = process.argv.slice(2)) {
  let documentsUrl = process.env.DOCUMENTS_URL?.trim() || DEFAULT_DOCUMENTS_URL;
  let outputDir =
    process.env.DOCUMENTS_OUTPUT_DIR?.trim() ||
    path.join(projectRoot, 'downloads', 'documents');
  let headed = false;
  let dryRun = false;
  const envIgn =
    process.env.DOCUMENTS_IGNORE_MANIFEST?.trim().toLowerCase() || '';
  let ignoreManifest = envIgn === '1' || envIgn === 'true' || envIgn === 'yes';
  let maxDepth = Number(process.env.DOCUMENTS_MAX_DEPTH || 32) || 32;
  let extensions = null;
  for (const a of args) {
    if (a.startsWith('--documents-url=')) documentsUrl = a.slice('--documents-url='.length).trim();
    if (a.startsWith('--output=')) outputDir = a.slice('--output='.length).trim();
    if (a === '--headed' || a === '--show') headed = true;
    if (a === '--dry-run' || a === '--no-download') dryRun = true;
    if (a === '--ignore-manifest') ignoreManifest = true;
    if (a.startsWith('--max-depth=')) {
      const n = parseInt(a.slice('--max-depth='.length), 10);
      if (Number.isFinite(n) && n >= 0) maxDepth = n;
    }
    if (a.startsWith('--extensions=')) {
      const raw = a.slice('--extensions='.length);
      extensions = new Set(
        raw
          .split(/[,;\s]+/)
          .map((x) => x.replace(/^\./, '').toLowerCase())
          .filter(Boolean)
      );
    }
  }
  return {
    documentsUrl,
    outputDir: path.resolve(outputDir),
    headed,
    dryRun,
    ignoreManifest,
    maxDepth,
    extensions: extensions && extensions.size ? extensions : DEFAULT_EXTENSIONS,
  };
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

function extractListingScript() {
  const FOLDER_PATH = '/documents/folders/';
  const folders = [];
  const files = [];

  for (const row of document.querySelectorAll('.media-folder_items.ac-folder-list')) {
    const nav = row.querySelector(`a.media-folder_name[href*="${FOLDER_PATH}"]`);
    if (!nav?.href) continue;
    const span = nav.querySelector('span');
    const label = (span?.textContent || nav.textContent || '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    folders.push({ label, listUrl: nav.href.split('#')[0] });
  }

  for (const row of document.querySelectorAll('.media-folder_items.ac-document-list')) {
    const dl = row.querySelector('li.download_file a[href]');
    if (!dl?.href) continue;
    const titleA = row.querySelector('a.media-folder_name');
    const dataTitle = titleA?.getAttribute('data-document-title')?.trim();
    const span = titleA?.querySelector('span');
    const fromSpan = span?.textContent?.trim();
    const title = dataTitle || fromSpan || titleA?.textContent?.trim() || 'documento';
    const extAttr = (titleA?.getAttribute('data-extension') || '').toLowerCase();
    files.push({
      downloadUrl: dl.href.split('#')[0],
      title,
      extHint: extAttr,
    });
  }

  return { folders, files };
}

async function gentleScrollForLazyContent(page) {
  await page
    .evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const h = Math.max(document.body?.scrollHeight || 0, 8000);
      const steps = Math.min(12, Math.ceil(h / 1200));
      for (let i = 0; i < steps; i++) {
        window.scrollBy(0, 1200);
        await sleep(350);
      }
      window.scrollTo(0, 0);
    })
    .catch(() => {});
}

async function loadListing(page, listUrl) {
  await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await new Promise((r) => setTimeout(r, 500));
  await gentleScrollForLazyContent(page);
  try {
    await page.waitForSelector('.media-folder_items', { timeout: 45000 });
  } catch {
    /* lista vazia ou DOM diferente */
  }
  return page.evaluate(extractListingScript);
}

function extFromTitle(title, extHint) {
  const t = String(title || '');
  const m = t.match(/\.([a-z0-9]+)$/i);
  if (m) return m[1].toLowerCase();
  if (extHint) return extHint.toLowerCase();
  return '';
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

async function buildCookieHeader(page) {
  const cookies = await page.cookies();
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
}

async function downloadBinaryWithSession(page, fileUrl, destPath, opts) {
  const { maxBytes, referer } = opts;
  const cookie = await buildCookieHeader(page);
  const ua = await page.evaluate(() => navigator.userAgent);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.fetchTimeoutMs || 300000);
  try {
    const res = await fetch(fileUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Cookie: cookie,
        'User-Agent': ua,
        Accept: '*/*',
        Referer: referer || page.url(),
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    const cl = res.headers.get('content-length');
    const expectedBytes = cl && /^\d+$/.test(cl) ? Number(cl) : undefined;
    if (expectedBytes != null && expectedBytes > maxBytes) {
      throw new Error(`content-length ${cl} acima do limite ${maxBytes}`);
    }
    const body = res.body;
    if (!body) throw new Error('resposta sem corpo');
    const nodeStream = Readable.fromWeb(body);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    const ws = fsSync.createWriteStream(destPath);
    let written = 0;
    for await (const chunk of nodeStream) {
      written += chunk.length;
      if (written > maxBytes) {
        ws.destroy();
        await fs.unlink(destPath).catch(() => {});
        throw new Error(`fluxo excedeu ${maxBytes} bytes`);
      }
      if (!ws.write(chunk)) {
        await new Promise((r) => ws.once('drain', r));
      }
    }
    ws.end();
    await finished(ws);
    if (written === 0) {
      await fs.unlink(destPath).catch(() => {});
      throw new Error('ficheiro vazio');
    }
    return { writtenBytes: written, expectedBytes };
  } finally {
    clearTimeout(timer);
  }
}

function classifyDocumentError(err) {
  const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();
  const name = err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';

  if (msg.includes('integrity:')) return 'integrity';
  if (msg.includes('parece html') || msg.includes('resposta foi html')) return 'html';
  if (msg.includes('timeout') || name === 'AbortError' || code === 'ABORT_ERR') return 'timeout';
  if (msg.startsWith('http 5') || msg.includes('http 429')) return 'http';
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
    return 'network';
  }
  if (msg.includes('fetch failed')) return 'network';
  return 'unknown';
}

function isRetryableDocumentError(err) {
  const kind = classifyDocumentError(err);
  if (kind === 'integrity' || kind === 'timeout' || kind === 'network') return true;
  if (kind === 'http') {
    const msg = err instanceof Error ? err.message : String(err || '');
    return /HTTP\s+5\d\d\b/.test(msg) || /HTTP\s+429\b/.test(msg);
  }
  // HTML geralmente é sessão expirada/permissão; pode recuperar mas sem reauth explícito tende a repetir.
  return false;
}

/**
 * BFS só para mapear ficheiros elegíveis (sem download).
 * @param {import('puppeteer').Page} page
 * @param {{ documentsUrl: string; outputDir: string; maxDepth: number; extensions: Set<string> }} cfg
 * @returns {Promise<Array<{ downloadUrl: string; title: string; extHint: string; relParts: string[]; listUrl: string; ext: string; documentItemId: string }>>}
 */
async function collectDocumentTasksFromSite(page, cfg) {
  const { documentsUrl, outputDir, maxDepth, extensions } = cfg;
  const visited = new Set();
  const queue = [{ listUrl: normalizeListUrl(documentsUrl), depth: 0, relParts: [] }];
  /** @type {Array<{ downloadUrl: string; title: string; extHint: string; relParts: string[]; listUrl: string; ext: string; documentItemId: string }>} */
  const tasks = [];

  while (queue.length) {
    const job = queue.shift();
    const key = normalizeListUrl(job.listUrl);
    if (visited.has(key)) continue;
    visited.add(key);

    let listing;
    try {
      listing = await loadListing(page, job.listUrl);
    } catch {
      continue;
    }

    const { folders, files } = listing;

    if (job.depth < maxDepth) {
      for (const f of folders) {
        const childKey = normalizeListUrl(f.listUrl);
        if (visited.has(childKey)) continue;
        const part = safeDirName(f.label);
        queue.push({
          listUrl: childKey,
          depth: job.depth + 1,
          relParts: [...job.relParts, part],
        });
      }
    }

    const baseDir =
      job.relParts.length === 0 ? outputDir : path.join(outputDir, ...job.relParts);
    await ensureDir(baseDir);

    for (const file of files) {
      const ext = extFromTitle(file.title, file.extHint);
      if (!extensions.has(ext)) continue;
      const documentItemId = stableDocumentItemId(file.downloadUrl);
      tasks.push({
        downloadUrl: file.downloadUrl.split('#')[0],
        title: file.title,
        extHint: file.extHint,
        relParts: [...job.relParts],
        listUrl: job.listUrl,
        ext,
        documentItemId,
      });
    }
  }
  return tasks;
}

/**
 * Fase de mapeamento: autentica e percorre pastas; devolve lista plana de URLs.
 *
 * @param {object} ctx
 * @param {import('puppeteer').Browser} ctx.browser
 * @param {import('puppeteer').Page} ctx.page
 */
export async function discoverDocumentTasks(ctx) {
  const { page } = ctx;
  const { documentsUrl, outputDir, maxDepth, extensions } = parseDocumentArgs();
  const user = process.env.FACULDADE_USER || '';
  const pass = process.env.FACULDADE_PASS || '';
  const sessionPath = path.join(projectRoot, 'session.json');

  page.setDefaultNavigationTimeout(120000);
  await ensureAuthenticated(page, documentsUrl, sessionPath, user, pass);

  const tasks = await collectDocumentTasksFromSite(page, {
    documentsUrl,
    outputDir,
    maxDepth,
    extensions,
  });
  return { tasks, documentsUrl, outputDir };
}

/**
 * @param {object} ctx
 * @param {import('puppeteer').Browser} ctx.browser
 * @param {import('puppeteer').Page} ctx.page
 * @param {object} [scraperOpts]
 * @param {Array<{ downloadUrl: string; title: string; extHint: string; relParts: string[]; listUrl: string; ext: string; documentItemId: string }>} [scraperOpts.tasks] — se definido, não refaz o crawl BFS
 * @param {string} [scraperOpts.logTag]
 */
export async function runDocumentScraper(ctx, scraperOpts = {}) {
  const { page } = ctx;
  const { documentsUrl, outputDir, dryRun, ignoreManifest, maxDepth, extensions } =
    parseDocumentArgs();
  const { log, error, warn } = makeTaggedLoggers(scraperOpts.logTag);
  const progress = scraperOpts.progress || null;

  const user = process.env.FACULDADE_USER || '';
  const pass = process.env.FACULDADE_PASS || '';
  const sessionPath = path.join(projectRoot, 'session.json');
  const maxBytes =
    Number(process.env.DOCUMENTS_MAX_BYTES || 500 * 1024 * 1024) || 500 * 1024 * 1024;
  const fetchTimeoutMs = Number(process.env.DOCUMENTS_FETCH_TIMEOUT_MS || 300000) || 300000;

  if (!documentsUrl.includes('/documents')) {
    warn('[AVISO] URL não contém /documents — confirme DOCUMENTS_URL / --documents-url=');
  }

  page.setDefaultNavigationTimeout(120000);

  await ensureAuthenticated(page, documentsUrl, sessionPath, user, pass);

  let downloaded = 0;
  let skipped = 0;
  let skippedManifest = 0;
  let errors = 0;
  let visitedSize = 0;

  const downloadsRootDefault = path.join(projectRoot, 'downloads');
  const { manifestPath, manifestRoot } = resolveManifestRootAndPath(
    downloadsRootDefault,
    outputDir
  );
  log(
    `[MANIFEST] ${manifestPath} (raiz de caminhos relativos: ${manifestRoot}) — idempotência ${
      ignoreManifest ? 'desativada (--ignore-manifest ou DOCUMENTS_IGNORE_MANIFEST)' : 'ativa'
    }`
  );

  if (scraperOpts.tasks?.length) {
    visitedSize = 0;
    for (const file of scraperOpts.tasks) {
      const ext = file.ext || extFromTitle(file.title, file.extHint);
      if (!extensions.has(ext)) {
        skipped++;
        continue;
      }
      const documentItemId = file.documentItemId || stableDocumentItemId(file.downloadUrl);
      if (
        !dryRun &&
        !ignoreManifest &&
        (await isItemCompleted(manifestPath, documentItemId, {
          verifyArtifact: true,
          manifestRoot,
        }))
      ) {
        skippedManifest++;
        continue;
      }
      const baseDir =
        file.relParts.length === 0 ? outputDir : path.join(outputDir, ...file.relParts);
      await ensureDir(baseDir);
      let base = safeFileName(file.title);
      if (!/\.[a-z0-9]+$/i.test(base)) {
        base = `${base}.${ext}`;
      }
      const destPath = await uniqueDestPath(baseDir, base);
      if (dryRun) {
        log(
          `  [dry-run] ${path.relative(outputDir, destPath) || base} ← ${file.downloadUrl}`
        );
        continue;
      }
      progress?.status?.(`DOCS: baixando ${path.relative(outputDir, destPath) || base}`);
      let attempts = 0;
      let lastBytes = 0;
      try {
        await withRetries(
          async () => {
            attempts++;
            await safeUnlink(destPath);
            const { writtenBytes, expectedBytes } = await downloadBinaryWithSession(
              page,
              file.downloadUrl,
              destPath,
              {
                maxBytes,
                referer: file.listUrl,
                fetchTimeoutMs,
              }
            );
            lastBytes = writtenBytes || 0;
            await validateBinaryFile({ filePath: destPath, expectedBytes });
            await markArtifactCompletedIfPresent({
              manifestPath,
              manifestRoot,
              itemId: documentItemId,
              kind: 'document',
              sourceUrl: file.downloadUrl,
              artifactAbsPath: destPath,
            });
          },
          {
            retries: 3,
            isRetryable: isRetryableDocumentError,
            onRetry: ({ attempt, retries, error: err, delayMs }) => {
              warn(
                `  [RETRY] ${base} — tentativa ${attempt}/${retries} falhou (${classifyDocumentError(
                  err
                )}); aguardando ${delayMs}ms`
              );
              progress?.status?.(
                `DOCS: retry ${attempt}/${retries} — ${path.relative(outputDir, destPath) || base}`
              );
            },
          }
        );
        downloaded++;
        log(`  [OK] ${path.relative(projectRoot, destPath)}`);
        progress?.itemDone?.({ bytes: lastBytes, itemId: documentItemId, filePath: destPath });
        progress?.status?.(`DOCS: OK — ${path.relative(outputDir, destPath) || base}`);
      } catch (e) {
        errors++;
        error(`  [ERRO] ${base}`, e instanceof Error ? e.message : e);
        await safeUnlink(destPath);
        progress?.itemError?.({
          itemId: documentItemId,
          errorKind: classifyDocumentError(e),
          message: e instanceof Error ? e.message : String(e),
        });
        await markArtifactError({
          manifestPath,
          manifestRoot,
          itemId: documentItemId,
          kind: 'document',
          sourceUrl: file.downloadUrl,
          reason: 'download falhou após retries',
          attempts: typeof attempts === 'number' && attempts > 0 ? attempts : 1,
          errorKind: classifyDocumentError(e),
          lastError: e,
        }).catch(() => {});
        progress?.status?.(`DOCS: erro — ${path.relative(outputDir, destPath) || base}`);
      }
    }
  } else {
    const visited = new Set();
    const queue = [{ listUrl: normalizeListUrl(documentsUrl), depth: 0, relParts: [] }];

    while (queue.length) {
      const job = queue.shift();
      const key = normalizeListUrl(job.listUrl);
      if (visited.has(key)) continue;
      visited.add(key);

      log(`[PASTA] depth=${job.depth} → ${key}`);
      let listing;
      try {
        listing = await loadListing(page, job.listUrl);
      } catch (e) {
        error('[ERRO] listagem', key, e instanceof Error ? e.message : e);
        errors++;
        continue;
      }

      const { folders, files } = listing;
      log(`  subpastas: ${folders.length} | ficheiros (DOM): ${files.length}`);

      if (job.depth < maxDepth) {
        for (const f of folders) {
          const childKey = normalizeListUrl(f.listUrl);
          if (visited.has(childKey)) continue;
          const part = safeDirName(f.label);
          queue.push({
            listUrl: childKey,
            depth: job.depth + 1,
            relParts: [...job.relParts, part],
          });
        }
      } else if (folders.length) {
        warn(
          `  [AVISO] max-depth=${maxDepth}; ${folders.length} pastas não exploradas neste ramo`
        );
      }

      const baseDir =
        job.relParts.length === 0 ? outputDir : path.join(outputDir, ...job.relParts);
      await ensureDir(baseDir);

      for (const file of files) {
        const ext = extFromTitle(file.title, file.extHint);
        if (!extensions.has(ext)) {
          skipped++;
          continue;
        }
        const documentItemId = stableDocumentItemId(file.downloadUrl);
        if (
          !dryRun &&
          !ignoreManifest &&
          (await isItemCompleted(manifestPath, documentItemId, {
            verifyArtifact: true,
            manifestRoot,
          }))
        ) {
          skippedManifest++;
          continue;
        }
        let base = safeFileName(file.title);
        if (!/\.[a-z0-9]+$/i.test(base)) {
          base = `${base}.${ext}`;
        }
        const destPath = await uniqueDestPath(baseDir, base);
        if (dryRun) {
          log(
            `  [dry-run] ${path.relative(outputDir, destPath) || base} ← ${file.downloadUrl}`
          );
          continue;
        }
        progress?.status?.(`DOCS: baixando ${path.relative(outputDir, destPath) || base}`);
        let attempts = 0;
        let lastBytes = 0;
        try {
          await withRetries(
            async () => {
              attempts++;
              await safeUnlink(destPath);
              const { writtenBytes, expectedBytes } = await downloadBinaryWithSession(
                page,
                file.downloadUrl,
                destPath,
                {
                  maxBytes,
                  referer: job.listUrl,
                  fetchTimeoutMs,
                }
              );
              lastBytes = writtenBytes || 0;
              await validateBinaryFile({ filePath: destPath, expectedBytes });
              await markArtifactCompletedIfPresent({
                manifestPath,
                manifestRoot,
                itemId: documentItemId,
                kind: 'document',
                sourceUrl: file.downloadUrl,
                artifactAbsPath: destPath,
              });
            },
            {
              retries: 3,
              isRetryable: isRetryableDocumentError,
              onRetry: ({ attempt, retries, error: err, delayMs }) => {
                warn(
                  `  [RETRY] ${base} — tentativa ${attempt}/${retries} falhou (${classifyDocumentError(
                    err
                  )}); aguardando ${delayMs}ms`
                );
                progress?.status?.(
                  `DOCS: retry ${attempt}/${retries} — ${path.relative(outputDir, destPath) || base}`
                );
              },
            }
          );
          downloaded++;
          log(`  [OK] ${path.relative(projectRoot, destPath)}`);
          progress?.itemDone?.({ bytes: lastBytes, itemId: documentItemId, filePath: destPath });
          progress?.status?.(`DOCS: OK — ${path.relative(outputDir, destPath) || base}`);
        } catch (e) {
          errors++;
          error(`  [ERRO] ${base}`, e instanceof Error ? e.message : e);
          await safeUnlink(destPath);
          progress?.itemError?.({
            itemId: documentItemId,
            errorKind: classifyDocumentError(e),
            message: e instanceof Error ? e.message : String(e),
          });
          await markArtifactError({
            manifestPath,
            manifestRoot,
            itemId: documentItemId,
            kind: 'document',
            sourceUrl: file.downloadUrl,
            reason: 'download falhou após retries',
            attempts: typeof attempts === 'number' && attempts > 0 ? attempts : 1,
            errorKind: classifyDocumentError(e),
            lastError: e,
          }).catch(() => {});
          progress?.status?.(`DOCS: erro — ${path.relative(outputDir, destPath) || base}`);
        }
      }
    }
    visitedSize = visited.size;
  }

  log(
    `[FIM] descarregados: ${downloaded} | ignorados (extensão): ${skipped} | já no manifest: ${skippedManifest} | erros: ${errors} | pastas visitadas: ${visitedSize}`
  );
}

/**
 * @param {object} [standaloneOpts]
 * @param {Awaited<ReturnType<typeof discoverDocumentTasks>>['tasks']} [standaloneOpts.tasks]
 * @param {string} [standaloneOpts.logTag]
 */
export async function runDocumentScraperStandalone(standaloneOpts = {}) {
  const { headed } = parseDocumentArgs();
  let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (executablePath && !(await fileExists(executablePath))) {
    console.error('[ERRO] PUPPETEER_EXECUTABLE_PATH inválido:', executablePath);
    printChromeHelp();
    process.exit(1);
  }

  let browser;
  try {
    browser = await launchBrowser({ headed });
  } catch {
    process.exit(1);
  }

  const page = await browser.newPage();
  try {
    await runDocumentScraper({ browser, page }, standaloneOpts);
  } catch (e) {
    console.error('[FATAL]', e);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}
