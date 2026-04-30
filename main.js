/**
 * Orquestrador: aulas e/ou documentos; modo cluster (crawl → shard → workers paralelos) ou sequencial clássico.
 */
import 'dotenv/config';
import path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { launchBrowser } from './src/utils/browser.mjs';
import { logSectionBanner } from './src/utils/logging.mjs';
import { ensureDir, projectRoot } from './src/utils/infnetShared.mjs';
import { partitionTasksForWorker } from './src/utils/shard.mjs';
import { workerLogTag } from './src/utils/workerLog.mjs';
import {
  parseLessonArgs,
  runLessonScraper,
  discoverLessonTasks,
} from './src/scrapers/lessonScraper.js';
import {
  parseDocumentArgs,
  runDocumentScraper,
  discoverDocumentTasks,
} from './src/scrapers/documentScraper.js';
import { isItemCompleted, resolveManifestRootAndPath } from './src/utils/downloadManifest.mjs';

function hasHeadedFlag() {
  return process.argv.some((a) => a === '--headed' || a === '--show');
}

function envFailFast() {
  const v = (process.env.ORCHESTRATOR_FAIL_FAST || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * @param {Awaited<ReturnType<typeof discoverLessonTasks>>['tasks']} tasks
 * @param {string} downloadsDir
 */
async function filterPendingLessonTasks(tasks, downloadsDir) {
  const { manifestPath, manifestRoot } = resolveManifestRootAndPath(
    downloadsDir,
    downloadsDir
  );
  const out = [];
  for (const t of tasks) {
    if (
      await isItemCompleted(manifestPath, t.transcriptItemId, {
        verifyArtifact: true,
        manifestRoot,
      })
    ) {
      continue;
    }
    out.push(t);
  }
  return out;
}

/**
 * @param {Awaited<ReturnType<typeof discoverDocumentTasks>>['tasks']} tasks
 * @param {string} outputDir
 */
async function filterPendingDocTasks(tasks, outputDir) {
  const downloadsRootDefault = path.join(projectRoot, 'downloads');
  const { manifestPath, manifestRoot } = resolveManifestRootAndPath(
    downloadsRootDefault,
    outputDir
  );
  const { dryRun, ignoreManifest } = parseDocumentArgs();
  if (dryRun || ignoreManifest) return [...tasks];
  const out = [];
  for (const t of tasks) {
    if (
      await isItemCompleted(manifestPath, t.documentItemId, {
        verifyArtifact: true,
        manifestRoot,
      })
    ) {
      continue;
    }
    out.push(t);
  }
  return out;
}

async function main() {
  const program = new Command();
  program
    .name('stripper-scrapper')
    .description('Infnet: aulas (Drive/transcrições) e documentos (BuddyPress)')
    .option('--all', 'Executar aulas e documentos (sequencial ou cluster)')
    .option('--lessons', 'Apenas scraper de aulas / transcrições')
    .option('--docs', 'Apenas scraper de documentos')
    .option('--fail-fast', 'Após erro fatal num módulo, não executar o seguinte (modo sequencial)')
    .option(
      '--workers <n>',
      'Número de browsers em paralelo no modo cluster (>=1)',
      (v) => parseInt(String(v), 10),
      2
    )
    .option(
      '--sequential',
      'Forçar um único browser (sem sharding paralelo), comportamento clássico'
    )
    .allowUnknownOption()
    .parse();

  const o = program.opts();
  const runL = Boolean(o.all || o.lessons);
  const runD = Boolean(o.all || o.docs);
  if (!runL && !runD) {
    program.outputHelp();
    process.exitCode = 1;
    return;
  }

  const headed = hasHeadedFlag();
  const failFast = Boolean(o.failFast) || envFailFast();
  const workersRaw = Number(o.workers);
  const workers =
    Number.isFinite(workersRaw) && workersRaw >= 1 ? Math.floor(workersRaw) : 2;
  const sequential = Boolean(o.sequential);

  const { noDownload, limit: lessonLimit } = parseLessonArgs();
  const docArgs = parseDocumentArgs();
  const downloadsDir = path.join(projectRoot, 'downloads');

  const useCluster =
    !sequential &&
    !noDownload &&
    !docArgs.dryRun &&
    workers >= 2 &&
    (runL || runD);

  if (!useCluster) {
    await runSequentialOrchestrator({
      runL,
      runD,
      headed,
      failFast,
    });
    return;
  }

  const mapTag = chalk.bold.magenta('[ORQUESTRADOR][MAPA]');
  console.log(
    mapTag,
    chalk.gray('Modo cluster: mapeamento → partição →'),
    chalk.bold(String(workers)),
    chalk.gray('workers (Promise.all).')
  );

  let mapBrowser;
  try {
    mapBrowser = await launchBrowser({ headed });
  } catch {
    process.exit(1);
    return;
  }

  const mapPage = await mapBrowser.newPage();
  let discoveredLessons = { courseName: '', tasks: [], emptyDiag: undefined };
  let discoveredDocs = { tasks: [], outputDir: downloadsDir };

  try {
    if (runL) {
      console.log(mapTag, chalk.magenta('Crawl: aulas…'));
      discoveredLessons = await discoverLessonTasks({
        browser: mapBrowser,
        page: mapPage,
      });
      if (!discoveredLessons.tasks.length && discoveredLessons.emptyDiag) {
        console.log(
          mapTag,
          '[ERRO] Nenhum .infnetci-recording-item encontrado',
          JSON.stringify(discoveredLessons.emptyDiag)
        );
      }
    }
    if (runD) {
      console.log(mapTag, chalk.magenta('Crawl: documentos…'));
      discoveredDocs = await discoverDocumentTasks({
        browser: mapBrowser,
        page: mapPage,
      });
    }
  } finally {
    await mapBrowser.close().catch(() => {});
  }

  let pendingLessons = runL ? await filterPendingLessonTasks(discoveredLessons.tasks, downloadsDir) : [];
  const maxLesson = Number.isFinite(lessonLimit) ? lessonLimit : Infinity;
  pendingLessons = pendingLessons.slice(0, maxLesson);

  let pendingDocs = runD
    ? await filterPendingDocTasks(discoveredDocs.tasks, discoveredDocs.outputDir)
    : [];

  const totalDomItems = discoveredLessons.tasks.length;
  const courseName = discoveredLessons.courseName || '';

  const workerHeaded = headed;
  const workerSlots = Array.from({ length: workers }, (_, w) => w);

  const results = await Promise.all(
    workerSlots.map(async (workerIndex) => {
      const wid = workerIndex + 1;
      const lessonShard = runL
        ? partitionTasksForWorker(pendingLessons, workers, workerIndex)
        : [];
      const docShard = runD
        ? partitionTasksForWorker(pendingDocs, workers, workerIndex)
        : [];
      const tempLesson = path.join(projectRoot, 'temp_downloads', `worker-${wid}`);
      await ensureDir(tempLesson);

      let browser;
      try {
        browser = await launchBrowser({
          headed: workerHeaded,
          preferHeadlessUnlessHeaded: true,
        });
      } catch {
        return {
          wid,
          ok: false,
          lessonError: new Error('Falha ao lançar browser'),
          docError: null,
          skipped: true,
        };
      }

      const page = await browser.newPage();
      let lessonError = null;
      let docError = null;
      try {
        if (lessonShard.length) {
          try {
            await runLessonScraper(
              { browser, page },
              {
                tasks: lessonShard,
                courseName,
                totalDomItems: totalDomItems || lessonShard.length,
                logTag: workerLogTag(wid, 'AULAS'),
                tempDownloadsDir: tempLesson,
              }
            );
          } catch (e) {
            lessonError = e instanceof Error ? e : new Error(String(e));
            console.error(
              workerLogTag(wid, 'AULAS'),
              chalk.red(lessonError.message)
            );
          }
        }
        const skipDocs = Boolean(failFast && lessonError && runL);
        if (runD && docShard.length && !skipDocs) {
          try {
            await runDocumentScraper(
              { browser, page },
              {
                tasks: docShard,
                logTag: workerLogTag(wid, 'DOCS'),
              }
            );
          } catch (e2) {
            docError = e2 instanceof Error ? e2 : new Error(String(e2));
            console.error(workerLogTag(wid, 'DOCS'), chalk.red(docError.message));
          }
        }
      } finally {
        await browser.close().catch(() => {});
      }
      return {
        wid,
        ok: !lessonError && !docError,
        lessonError,
        docError,
        skipped: false,
      };
    })
  );

  const failed = results.filter((r) => r.lessonError || r.docError);
  const okCount = results.filter((r) => r.ok).length;
  console.log('');
  console.log(
    chalk.bold.green('[ORQUESTRADOR]'),
    'Resumo cluster:',
    chalk.green(`workers OK (sem exceção): ${okCount}/${workers}`),
    failed.length ? chalk.red(`com falhas: ${failed.length}`) : ''
  );
  for (const r of results) {
    if (r.skipped) {
      console.log(chalk.yellow(`  [WORKER-${r.wid}] browser não arrancou`));
      continue;
    }
    const bits = [];
    bits.push(r.lessonError ? chalk.red('aulas: erro') : chalk.green('aulas: ok'));
    bits.push(r.docError ? chalk.red('docs: erro') : chalk.green('docs: ok'));
    console.log(`  [WORKER-${r.wid}]`, ...bits);
  }
  console.log('');

  if (failed.length || results.some((r) => r.skipped)) {
    process.exitCode = 1;
  }
}

/**
 * @param {{ runL: boolean; runD: boolean; headed: boolean; failFast: boolean }} p
 */
async function runSequentialOrchestrator(p) {
  const { runL, runD, headed, failFast } = p;
  let browser;
  try {
    browser = await launchBrowser({ headed });
  } catch {
    process.exit(1);
    return;
  }

  const page = await browser.newPage();
  let moduleFailed = false;

  try {
    if (runL) {
      logSectionBanner(
        'AULAS / TRANSCRIÇÕES',
        'Zoom Infnet + Google Drive (CLASSES_URL)'
      );
      try {
        await runLessonScraper({ browser, page });
      } catch (e) {
        moduleFailed = true;
        console.error(
          '[ORQUESTRADOR] Módulo aulas:',
          e instanceof Error ? e.message : e
        );
        if (failFast) {
          console.error('[ORQUESTRADOR] fail-fast: a saltar documentos.');
          return;
        }
      }
    }

    if (runD && !(failFast && moduleFailed)) {
      logSectionBanner('DOCUMENTOS', 'BuddyPress /documents (DOCUMENTS_URL)');
      try {
        await runDocumentScraper({ browser, page });
      } catch (e) {
        moduleFailed = true;
        console.error(
          '[ORQUESTRADOR] Módulo documentos:',
          e instanceof Error ? e.message : e
        );
      }
    }
  } finally {
    console.log('[ORQUESTRADOR] A fechar o browser…');
    await browser.close().catch(() => {});
  }

  if (moduleFailed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
