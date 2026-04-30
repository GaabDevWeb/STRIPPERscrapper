/**
 * Arranque partilhado do Puppeteer (Chrome, headless, viewport).
 */
import puppeteer from 'puppeteer';
import { fileExists, detectSystemChrome, printChromeHelp } from './infnetShared.mjs';

/**
 * @param {{ headed?: boolean }} opts
 * @returns {Promise<string | undefined>}
 */
export async function resolveExecutablePath() {
  let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (executablePath && !(await fileExists(executablePath))) {
    console.error('[ERRO] PUPPETEER_EXECUTABLE_PATH não existe:', executablePath);
    printChromeHelp();
    throw new Error('PUPPETEER_EXECUTABLE_PATH inválido');
  }
  if (!executablePath) {
    executablePath = await detectSystemChrome();
  }
  return executablePath;
}

/**
 * @param {{ headed?: boolean }} opts
 */
export function buildLaunchOptions(opts = {}) {
  const headed = opts.headed ?? false;
  const showBrowser = headed || process.env.HEADLESS === '0';
  if (showBrowser) {
    console.log('[UI] Browser visível (use --headed ou HEADLESS=0 no .env)');
  }
  return {
    showBrowser,
    launchOpts: {
      headless: !showBrowser,
      defaultViewport: showBrowser ? null : { width: 1280, height: 900 },
    },
  };
}

/**
 * @param {{ headed?: boolean }} opts
 * @returns {Promise<import('puppeteer').Browser>}
 */
export async function launchBrowser(opts = {}) {
  const executablePath = await resolveExecutablePath();
  const { showBrowser, launchOpts } = buildLaunchOptions(opts);
  try {
    return await puppeteer.launch({
      ...launchOpts,
      ...(executablePath ? { executablePath } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Could not find Chrome')) {
      printChromeHelp();
      throw new Error('Chrome não encontrado para o Puppeteer');
    }
    throw e;
  }
}
