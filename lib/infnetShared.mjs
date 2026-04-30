/**
 * Utilitários compartilhados Infnet (sessão, Chrome, paths seguros).
 * Usado por `stripper.js`, `documentsScraper.js` e outros scripts ESM.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

export const BASE_ORIGIN = 'https://infnet.online';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.join(__dirname, '..');

/**
 * @param {string} name
 * @param {{ maxLen?: number; fallback?: string }} [opts]
 */
export function safeDirName(name, opts = {}) {
  const maxLen = opts.maxLen ?? 120;
  const fallback = opts.fallback ?? 'pasta';
  const s = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, maxLen);
  return (s || fallback).replace(/\s/g, '_');
}

export function safeFileName(name) {
  const s = String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 200);
  return s || 'arquivo';
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function detectSystemChrome() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
        : null,
    ].filter(Boolean);
    for (const c of candidates) {
      if (await fileExists(c)) return c;
    }
  } else if (process.platform === 'darwin') {
    const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (await fileExists(mac)) return mac;
  } else {
    for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']) {
      if (await fileExists(c)) return c;
    }
  }
  return undefined;
}

export function printChromeHelp() {
  console.error('[ERRO] Puppeteer não encontrou o Chrome esperado.');
  console.error('  A) Instale o Google Chrome e volte a correr; ou');
  console.error(
    '  B) No .env: PUPPETEER_EXECUTABLE_PATH=caminho\\para\\chrome.exe  (ex.: C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe); ou'
  );
  console.error('  C) Com espaço em disco: npx puppeteer browsers install chrome');
}

export async function loadSession(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveSession(page, filePath) {
  const cookies = await page.cookies();
  const localStorageData = await page.evaluate(() => {
    const o = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      o[k] = localStorage.getItem(k);
    }
    return o;
  });
  await fs.writeFile(
    filePath,
    JSON.stringify({ cookies, localStorage: localStorageData }, null, 2),
    'utf8'
  );
}

export async function applySession(page, session) {
  if (!session?.cookies?.length) return;
  await page.goto(`${BASE_ORIGIN}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.setCookie(...session.cookies);
  if (session.localStorage && typeof session.localStorage === 'object') {
    await page.evaluate((data) => {
      for (const [k, v] of Object.entries(data)) {
        if (v != null) localStorage.setItem(k, String(v));
      }
    }, session.localStorage);
  }
}

export async function findFirst(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return el;
  }
  return null;
}

export async function login(page, user, pass) {
  const userSelectors = [
    'input#user_login',
    'input[name="log"]',
    'input[type="email"]',
    'input[placeholder*="e-mail" i]',
  ];
  const passSelectors = ['input#user_pass', 'input[name="pwd"]', 'input[type="password"]'];

  const userEl = await findFirst(page, userSelectors);
  const passEl = await findFirst(page, passSelectors);
  if (!userEl || !passEl) {
    throw new Error('Campos de login não encontrados');
  }

  await userEl.click({ clickCount: 3 });
  await userEl.type(user, { delay: 12 });
  await passEl.click({ clickCount: 3 });
  await passEl.type(pass, { delay: 12 });

  const submit =
    (await page.$('input#wp-submit')) ||
    (await page.$('input[name="wp-submit"]')) ||
    (await page.$('button[type="submit"]'));

  if (submit) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {}),
      submit.click(),
    ]);
  } else {
    await page
      .evaluate(() => {
        const f = document.querySelector('form');
        if (f) f.submit();
      })
      .catch(() => {});
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 90000 }).catch(() => {});
  }
}

/** @param {number} [settleMs=600] pausa após domcontentloaded (stripper usa 800). */
export async function gotoUrl(page, targetUrl, settleMs = 600) {
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await new Promise((r) => setTimeout(r, settleMs));
}

/**
 * Garante sessão válida para a URL alvo (documentos, aulas, etc.).
 * @param {{ gotoSettleMs?: number }} [opts] stripper usa 800 ms; documentos podem omitir (600).
 */
export async function ensureAuthenticated(page, targetUrl, sessionPath, user, pass, opts = {}) {
  const settleMs = opts.gotoSettleMs ?? 600;
  const session = await loadSession(sessionPath);
  if (session) {
    await applySession(page, session);
  }

  await gotoUrl(page, targetUrl, settleMs);

  if (page.url().includes('wp-login.php')) {
    if (!user || !pass) {
      throw new Error('FACULDADE_USER / FACULDADE_PASS ausentes (.env)');
    }
    console.log('[LOGIN] Tentando autenticação…');
    await login(page, user, pass);
    await gotoUrl(page, targetUrl, settleMs);
    if (page.url().includes('wp-login.php')) {
      throw new Error('[LOGIN] Falha: ainda na tela de login');
    }
    console.log('[LOGIN] Sucesso');
    await saveSession(page, sessionPath);
  } else {
    console.log('[LOGIN] Sessão válida');
    if (!session) await saveSession(page, sessionPath);
  }
}
