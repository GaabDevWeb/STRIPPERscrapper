import fs from 'fs/promises';
import path from 'path';
import {
  projectRoot,
  ensureDir,
  fileExists,
  printChromeHelp,
  ensureAuthenticated,
  safeDirName,
  gotoUrl,
} from '../utils/infnetShared.mjs';
import {
  stableTranscriptItemId,
  resolveManifestRootAndPath,
  isItemCompleted,
  markArtifactCompletedIfPresent,
} from '../utils/downloadManifest.mjs';
import { launchBrowser } from '../utils/browser.mjs';

const DEFAULT_CLASSES_URL =
  'https://infnet.online/grupos/fundamentos-do-processamento-de-dados-26e1-26e2-93422564/infnet-ci-zoom-mettings/';

/** @param {string[]} [args] */
export function parseLessonArgs(args = process.argv.slice(2)) {
  let limit = Infinity;
  let noDownload = false;
  let headed = false;
  for (const a of args) {
    if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice('--limit='.length), 10);
      limit = Number.isFinite(n) && n > 0 ? n : Infinity;
    }
    if (a === '--no-download') noDownload = true;
    if (a === '--headed' || a === '--show') headed = true;
  }
  return { limit, noDownload, headed };
}

function humanizePathSegment(slug) {
  return String(slug || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanGroupSlug(slug) {
  const parts = String(slug || '').split('-').filter(Boolean);
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (/^\d{5,}$/.test(last) || /^[0-9a-f]{10,}$/i.test(last)) {
      parts.pop();
      continue;
    }
    if (/^26e\d+$/i.test(last) || /^\d+e\d+$/i.test(last)) {
      parts.pop();
      continue;
    }
    break;
  }
  return parts.join('-');
}

function courseFromClassesUrl(classesUrl) {
  try {
    const u = new URL(classesUrl);
    const parts = u.pathname.split('/').filter(Boolean);
    const gi = parts.indexOf('grupos');
    if (gi >= 0 && parts[gi + 1]) {
      return humanizePathSegment(cleanGroupSlug(parts[gi + 1]));
    }
  } catch {
    /* ignore */
  }
  return '';
}

async function resolveCourseTitle(page, classesUrl) {
  const fromEnv =
    process.env.DISCIPLINE_NAME?.trim() ||
    process.env.COURSE_NAME?.trim();
  if (fromEnv) return fromEnv;

  const fromPage = await page.evaluate(() => {
    const accordionTexts = [
      ...document.querySelectorAll('button.infnetci-accordion-button'),
    ]
      .map((b) => b.textContent.trim())
      .filter((t) => t.length > 1);
    if (accordionTexts.length) {
      const uniq = [...new Set(accordionTexts)];
      if (uniq.length === 1) return uniq[0];
      if (uniq.length <= 3) return uniq.join(' · ');
      return `Vários módulos (${uniq.length}) — ${uniq.slice(0, 2).join(' · ')}…`;
    }

    const pick = (sel) => {
      const el = document.querySelector(sel);
      const t = el?.textContent?.trim() || '';
      return t;
    };
    const selectors = [
      'h1.entry-title',
      '.entry-header h1',
      '.bb-focus-header h1',
      '.group-header h1',
      '[class*="group-title"] h1',
      'article h1',
      'main h1',
      'h1',
      '.entry-title',
    ];
    for (const s of selectors) {
      const t = pick(s);
      if (t.length > 2 && t.length < 240) return t;
    }
    let title = (document.title || '').trim();
    title = title
      .replace(/\s*[|\-–—]\s*Instituto Infnet.*$/i, '')
      .replace(/\s*[|\-–—]\s*Infnet.*$/i, '')
      .trim();
    if (title.length > 2 && title.length < 240) return title;
    return '';
  });

  if (fromPage) return fromPage;

  const fromUrl = courseFromClassesUrl(classesUrl);
  if (fromUrl) return fromUrl;

  return 'Disciplina';
}

function slugify(title, index) {
  const s = String(title || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 120);
  return s || `aula_${index}`;
}

function gotoClasses(page, classesUrl) {
  return gotoUrl(page, classesUrl, 800);
}

async function setDownloadPath(page, downloadDir) {
  const client = await page.createCDPSession();
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: path.resolve(downloadDir),
  });
}

async function listFileNames(dir) {
  try {
    return new Set(await fs.readdir(dir));
  } catch {
    return new Set();
  }
}

async function waitNewStableFile(dir, beforeSet, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await fs.readdir(dir);
    for (const name of names) {
      if (beforeSet.has(name)) continue;
      if (name.endsWith('.crdownload') || name.endsWith('.tmp')) continue;
      const full = path.join(dir, name);
      let st1;
      try {
        st1 = await fs.stat(full);
      } catch {
        continue;
      }
      if (!st1.isFile()) continue;
      await new Promise((r) => setTimeout(r, 600));
      let st2;
      try {
        st2 = await fs.stat(full);
      } catch {
        continue;
      }
      if (st1.size === st2.size && st2.size > 0) return full;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  throw new Error('Timeout aguardando arquivo de download');
}

async function openTranscriptPageByIndex(browser, mainPage, itemIndex) {
  const targetPromise = browser.waitForTarget(
    (t) => t.type() === 'page' && t.opener() === mainPage.target(),
    { timeout: 45000 }
  );

  await mainPage.evaluate((idx) => {
    const items = [...document.querySelectorAll('.infnetci-recording-item')];
    const a = items[idx]?.querySelector('.transcription-link');
    if (a) a.click();
  }, itemIndex);

  try {
    const target = await targetPromise;
    const p = await target.page();
    if (!p) throw new Error('Página popup nula');
    return p;
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    const u = mainPage.url();
    if (u.includes('drive.google.com') || u.includes('docs.google.com')) {
      return mainPage;
    }
    throw new Error('Nova aba do Drive não abriu');
  }
}

async function clickDriveDownload(drivePage) {
  await drivePage.waitForSelector('body', { timeout: 30000 });

  const selectors = [
    '[role="button"][aria-label="Baixar"]',
    'div[aria-label="Baixar"]',
    'button[aria-label="Baixar"]',
    '[aria-label="Baixar"]',
    '[data-tooltip="Baixar"]',
    'button[aria-label="Fazer download"]',
    'div[aria-label="Fazer download"]',
    'button[aria-label="Download"]',
    'div[aria-label="Download"]',
    '[data-tooltip*="Baixar" i]',
    '[data-tooltip*="Download" i]',
    'button[data-tooltip*="Download" i]',
    '.ndfHFb-c4YZDc-LgbsSe[aria-label="Baixar"]',
  ];

  const tryClickInContext = async (ctx) => {
    for (const sel of selectors) {
      const el = await ctx.$(sel);
      if (!el) continue;
      const box = await el.boundingBox().catch(() => null);
      const visible = await el.isIntersectingViewport().catch(() => !!box);
      if (!visible && !box) continue;
      await el.click({ delay: 40 }).catch(async () => {
        await ctx.evaluate((s) => {
          const n = document.querySelector(s);
          if (n) n.click();
        }, sel);
      });
      await new Promise((r) => setTimeout(r, 1000));
      return true;
    }
    return false;
  };

  for (let attempt = 0; attempt < 18; attempt++) {
    const frames = drivePage.frames();
    for (const frame of frames) {
      try {
        if (await tryClickInContext(frame)) return;
      } catch {
        /* frame desanexado */
      }
    }
    await new Promise((r) => setTimeout(r, 450));
  }
  throw new Error('Botão de download não encontrado no Drive');
}

function yamlScalar(value) {
  if (value == null) return '""';
  return JSON.stringify(String(value));
}

export async function toMarkdown(filePath, metadata) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const mdPath = path.join(dir, `${base}.md`);
  const downloadedAt =
    metadata.downloaded_at || new Date().toISOString();
  const content = [
    '---',
    `title: ${yamlScalar(metadata.title)}`,
    `source_url: ${yamlScalar(metadata.source_url)}`,
    `course: ${yamlScalar(metadata.course ?? '')}`,
    `transcript_file: ${yamlScalar(path.basename(filePath))}`,
    `downloaded_at: ${yamlScalar(downloadedAt)}`,
    '---',
    '',
    '',
  ].join('\n');
  await fs.writeFile(mdPath, content, 'utf8');
  return mdPath;
}

/**
 * Transcrições / aulas (Zoom Infnet + Drive). Não fecha o browser.
 *
 * @param {object} ctx
 * @param {import('puppeteer').Browser} ctx.browser
 * @param {import('puppeteer').Page} ctx.page
 */
export async function runLessonScraper(ctx) {
  const { browser, page } = ctx;
  const { limit, noDownload } = parseLessonArgs();
  const classesUrl = process.env.CLASSES_URL || DEFAULT_CLASSES_URL;
  const user = process.env.FACULDADE_USER || '';
  const pass = process.env.FACULDADE_PASS || '';
  const sessionPath = path.join(projectRoot, 'session.json');
  const downloadsDir = path.join(projectRoot, 'downloads');
  const tempDownloads = path.join(projectRoot, 'temp_downloads');

  await ensureDir(downloadsDir);
  await ensureDir(tempDownloads);

  await ensureAuthenticated(page, classesUrl, sessionPath, user, pass, {
    gotoSettleMs: 800,
  });

  const itemData = await page.evaluate(() => {
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    const accButtons = [
      ...document.querySelectorAll('button.infnetci-accordion-button'),
    ];
    const items = [...document.querySelectorAll('.infnetci-recording-item')];

    return items
      .map((el) => {
        const h3 = el.querySelector('h3');
        const a = el.querySelector('.transcription-link');
        let accordionTitle = '';
        for (const btn of accButtons) {
          const pos = btn.compareDocumentPosition(el);
          if (pos & FOLLOWING) {
            accordionTitle = btn.textContent.trim();
          }
        }
        return {
          title: h3 ? h3.textContent.trim() : '',
          href: a ? a.href : '',
          accordionTitle,
        };
      })
      .filter((x) => x.href);
  });

  if (!itemData.length) {
    const diag = await page.evaluate(() => ({
      count: document.querySelectorAll('.infnetci-recording-item').length,
      snippet: document.body ? document.body.innerText.slice(0, 400).replace(/\s+/g, ' ') : '',
    }));
    console.log('[ERRO]', 'Nenhum .infnetci-recording-item encontrado', JSON.stringify(diag));
    return;
  }

  const courseName = await resolveCourseTitle(page, classesUrl);
  const totalAulas = itemData.length;
  const n = Math.min(totalAulas, limit);
  const { manifestPath, manifestRoot } = resolveManifestRootAndPath(
    downloadsDir,
    downloadsDir
  );
  console.log(`[DISCIPLINA] Baixando aulas de: ${courseName}`);
  console.log(`[INÍCIO] Execução: até ${n} novo(s) download(s) (${totalAulas} listada(s) na página).`);

  let processed = 0;
  let skippedAlreadyDone = 0;

  for (let i = 0; i < itemData.length && processed < n; i++) {
    const { title: rawTitle, href, accordionTitle } = itemData[i];
    const title = rawTitle || `aula_${i + 1}`;
    const aulaNum = i + 1;
    const titleShort = title.slice(0, 72) + (title.length > 72 ? '…' : '');
    const sectionLabel = (accordionTitle && accordionTitle.trim()) || courseName;
    const transcriptItemId = stableTranscriptItemId(href);
    try {
      if (
        !noDownload &&
        (await isItemCompleted(manifestPath, transcriptItemId, {
          verifyArtifact: true,
          manifestRoot,
        }))
      ) {
        skippedAlreadyDone++;
        continue;
      }

      console.log(
        `[EXTRAINDO] ${sectionLabel} — Aula ${aulaNum}/${totalAulas}: ${titleShort}`
      );

      if (noDownload) {
        console.log('[OK]', `(dry-run) ${sectionLabel} | Aula ${aulaNum}:`, href);
        processed++;
        continue;
      }

      const before = await listFileNames(tempDownloads);
      const drivePage = await openTranscriptPageByIndex(browser, page, i);
      await setDownloadPath(drivePage, tempDownloads);
      try {
        await drivePage.bringToFront().catch(() => {});
        await clickDriveDownload(drivePage);
        const downloaded = await waitNewStableFile(tempDownloads, before, 120000);
        const ext = path.extname(downloaded) || '.bin';
        const slug = slugify(title, i + 1);
        const disciplineDir = path.join(
          downloadsDir,
          safeDirName(sectionLabel, { maxLen: 80, fallback: 'Disciplina' })
        );
        await ensureDir(disciplineDir);
        const dest = path.join(disciplineDir, `${slug}${ext}`);
        await fs.rename(downloaded, dest);
        const meta = {
          title,
          source_url: href,
          course: sectionLabel,
          downloaded_at: new Date().toISOString(),
        };
        const mdWritten = await toMarkdown(dest, meta);
        await markArtifactCompletedIfPresent({
          manifestPath,
          manifestRoot,
          itemId: transcriptItemId,
          kind: 'transcript',
          sourceUrl: href,
          artifactAbsPath: dest,
          markdownAbsPath: mdWritten,
        });
        const baseName = path.basename(dest);
        console.log('[OK]', `${sectionLabel} | Aula ${aulaNum}: ${baseName}`);
      } finally {
        if (drivePage !== page) {
          await drivePage.close().catch(() => {});
        }
        await page.bringToFront().catch(() => {});
        await gotoClasses(page, classesUrl).catch(() => {});
      }
      processed++;
    } catch (err) {
      console.error(
        '[ERRO]',
        `${sectionLabel} | Aula ${aulaNum}:`,
        titleShort,
        err instanceof Error ? err.message : err
      );
      await gotoClasses(page, classesUrl).catch(() => {});
    }
  }

  if (skippedAlreadyDone > 0) {
    console.log(
      `[IDEMPOTÊNCIA] ${skippedAlreadyDone} aula(s) já registada(s) no manifest — omitidas.`
    );
  }
}

export async function runLessonScraperStandalone() {
  const { headed } = parseLessonArgs();
  let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (executablePath && !(await fileExists(executablePath))) {
    console.error('[ERRO] PUPPETEER_EXECUTABLE_PATH não existe:', executablePath);
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
    await runLessonScraper({ browser, page });
  } catch (e) {
    console.error('[ERRO]', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}
