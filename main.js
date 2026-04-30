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
import { createDashboard } from './src/utils/dashboard.mjs';
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

/**
 * Adapta eventos dos scrapers para o dashboard (TUI).
 * @param {object} p
 * @param {number} p.wid
 * @param {'AULAS' | 'DOCS'} p.section
 * @param {ReturnType<typeof createDashboard>} p.dashboard
 */
function makeDashboardProgress(p) {
  const { wid, section, dashboard } = p;
  return {
    status: (text) => dashboard.setWorkerStatus(wid, text),
    itemDone: ({ bytes }) =>
      dashboard.onItemDone({ count: 1, bytes: Number(bytes) || 0 }),
    itemError: ({ message, errorKind }) => {
      const kind = errorKind ? ` (${errorKind})` : '';
      dashboard.onError(
        `${workerLogTag(wid, section)}${kind} ${message || ''}`.trim()
      );
    },
  };
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
    .option('--no-dashboard', 'Desativar dashboard TUI (força logs simples)')
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
  const wantsDashboard = !Boolean(o.noDashboard);
  const canDashboard = Boolean(process.stdout.isTTY) && wantsDashboard;

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
      dashboardEnabled: canDashboard,
      downloadsDir,
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

  const totalItems = pendingLessons.length + pendingDocs.length;
  const dashboard = createDashboard({
    enabled: canDashboard,
    title: 'StripperScrapper — Dashboard',
    workers,
    renderFps: 10,
  });
  dashboard.setTotals(totalItems);
  const restoreConsole = dashboard.captureConsole();

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
        dashboard.setWorkerStatus(wid, 'A iniciar browser…');
        browser = await launchBrowser({
          headed: workerHeaded,
          preferHeadlessUnlessHeaded: true,
        });
      } catch {
        dashboard.onError(`${workerLogTag(wid, 'ORQ')} Falha ao lançar browser`);
        dashboard.setWorkerStatus(wid, 'Falha ao lançar browser');
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
          dashboard.setWorkerStatus(
            wid,
            `AULAS: ${lessonShard.length} itens (em execução)`
          );
          try {
            await runLessonScraper(
              { browser, page },
              {
                tasks: lessonShard,
                courseName,
                totalDomItems: totalDomItems || lessonShard.length,
                logTag: workerLogTag(wid, 'AULAS'),
                tempDownloadsDir: tempLesson,
                progress: makeDashboardProgress({ wid, section: 'AULAS', dashboard }),
              }
            );
            dashboard.setWorkerStatus(wid, 'AULAS: concluído');
          } catch (e) {
            lessonError = e instanceof Error ? e : new Error(String(e));
            console.error(
              workerLogTag(wid, 'AULAS'),
              chalk.red(lessonError.message)
            );
            dashboard.onError(
              `${workerLogTag(wid, 'AULAS')} ${lessonError.message || String(lessonError)}`
            );
            dashboard.setWorkerStatus(wid, 'AULAS: erro');
          }
        } else if (runL) {
          dashboard.setWorkerStatus(wid, 'AULAS: (nenhum item no shard)');
        }
        const skipDocs = Boolean(failFast && lessonError && runL);
        if (runD && docShard.length && !skipDocs) {
          dashboard.setWorkerStatus(
            wid,
            `DOCS: ${docShard.length} itens (em execução)`
          );
          try {
            await runDocumentScraper(
              { browser, page },
              {
                tasks: docShard,
                logTag: workerLogTag(wid, 'DOCS'),
                progress: makeDashboardProgress({ wid, section: 'DOCS', dashboard }),
              }
            );
            dashboard.setWorkerStatus(wid, 'DOCS: concluído');
          } catch (e2) {
            docError = e2 instanceof Error ? e2 : new Error(String(e2));
            console.error(workerLogTag(wid, 'DOCS'), chalk.red(docError.message));
            dashboard.onError(
              `${workerLogTag(wid, 'DOCS')} ${docError.message || String(docError)}`
            );
            dashboard.setWorkerStatus(wid, 'DOCS: erro');
          }
        } else if (runD && docShard.length && skipDocs) {
          dashboard.setWorkerStatus(wid, 'DOCS: skip (fail-fast após erro em aulas)');
        } else if (runD && !docShard.length) {
          dashboard.setWorkerStatus(wid, 'DOCS: (nenhum item no shard)');
        }
      } finally {
        await browser.close().catch(() => {});
      }
      if (!lessonError && !docError) {
        dashboard.setWorkerStatus(wid, 'OK');
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
  const clusterOk = !(failed.length || results.some((r) => r.skipped));
  restoreConsole();
  dashboard.finalizeAndPrintSummary({
    ok: clusterOk,
    downloadsDir,
    outputDir: discoveredDocs.outputDir,
    workers,
  });

  if (!clusterOk) {
    process.exitCode = 1;
  }
}

/**
 * @param {{
 *   runL: boolean;
 *   runD: boolean;
 *   headed: boolean;
 *   failFast: boolean;
 *   dashboardEnabled: boolean;
 *   downloadsDir: string;
 * }} p
 */
async function runSequentialOrchestrator(p) {
  const { runL, runD, headed, failFast, dashboardEnabled, downloadsDir } = p;
  const dashboard = createDashboard({
    enabled: dashboardEnabled,
    title: 'StripperScrapper — Dashboard',
    workers: 1,
    renderFps: 10,
  });
  const restoreConsole = dashboard.captureConsole();

  let browser;
  try {
    dashboard.setWorkerStatus(1, 'A iniciar browser…');
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
        dashboard.setWorkerStatus(1, 'AULAS: em execução');
        await runLessonScraper(
          { browser, page },
          { progress: makeDashboardProgress({ wid: 1, section: 'AULAS', dashboard }) }
        );
        dashboard.setWorkerStatus(1, 'AULAS: concluído');
      } catch (e) {
        moduleFailed = true;
        console.error(
          '[ORQUESTRADOR] Módulo aulas:',
          e instanceof Error ? e.message : e
        );
        dashboard.onError(
          `[ORQUESTRADOR][AULAS] ${e instanceof Error ? e.message : String(e)}`
        );
        dashboard.setWorkerStatus(1, 'AULAS: erro');
        if (failFast) {
          console.error('[ORQUESTRADOR] fail-fast: a saltar documentos.');
          return;
        }
      }
    }

    if (runD && !(failFast && moduleFailed)) {
      logSectionBanner('DOCUMENTOS', 'BuddyPress /documents (DOCUMENTS_URL)');
      try {
        dashboard.setWorkerStatus(1, 'DOCS: em execução');
        await runDocumentScraper(
          { browser, page },
          { progress: makeDashboardProgress({ wid: 1, section: 'DOCS', dashboard }) }
        );
        dashboard.setWorkerStatus(1, 'DOCS: concluído');
      } catch (e) {
        moduleFailed = true;
        console.error(
          '[ORQUESTRADOR] Módulo documentos:',
          e instanceof Error ? e.message : e
        );
        dashboard.onError(
          `[ORQUESTRADOR][DOCS] ${e instanceof Error ? e.message : String(e)}`
        );
        dashboard.setWorkerStatus(1, 'DOCS: erro');
      }
    }
  } finally {
    console.log('[ORQUESTRADOR] A fechar o browser…');
    await browser.close().catch(() => {});
  }

  restoreConsole();
  dashboard.finalizeAndPrintSummary({
    ok: !moduleFailed,
    downloadsDir,
    workers: 1,
  });

  if (moduleFailed) process.exitCode = 1;
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
