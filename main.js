/**
 * Ponto de entrada único: aulas (transcrições) e/ou documentos com uma sessão Puppeteer partilhada.
 */
import 'dotenv/config';
import { Command } from 'commander';
import { launchBrowser } from './src/utils/browser.mjs';
import { logSectionBanner } from './src/utils/logging.mjs';
import { runLessonScraper } from './src/scrapers/lessonScraper.js';
import { runDocumentScraper } from './src/scrapers/documentScraper.js';

function hasHeadedFlag() {
  return process.argv.some((a) => a === '--headed' || a === '--show');
}

function envFailFast() {
  const v = (process.env.ORCHESTRATOR_FAIL_FAST || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

async function main() {
  const program = new Command();
  program
    .name('stripper-scrapper')
    .description('Infnet: aulas (Drive/transcrições) e documentos (BuddyPress)')
    .option('--all', 'Executar aulas e documentos em sequência na mesma sessão do browser')
    .option('--lessons', 'Apenas scraper de aulas / transcrições')
    .option('--docs', 'Apenas scraper de documentos')
    .option('--fail-fast', 'Após erro fatal num módulo, não executar o seguinte')
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
        console.error('[ORQUESTRADOR] Módulo aulas:', e instanceof Error ? e.message : e);
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
        console.error('[ORQUESTRADOR] Módulo documentos:', e instanceof Error ? e.message : e);
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
