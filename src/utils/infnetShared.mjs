/**
 * Utilitários compartilhados Infnet (sessão, Chrome, paths seguros).
 * Usado pelos scrapers e pelo orquestrador.
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

export const BASE_ORIGIN = 'https://infnet.online';

/**
 * Infere a URL BuddyPress `…/grupos/{slug}/documents/` a partir de qualquer URL do mesmo grupo
 * (ex. `CLASSES_URL` com `…/grupos/{slug}/infnet-ci-zoom-mettings/`).
 * @param {string} gruposPageUrl
 * @returns {string} href normalizado ou string vazia se o path não for reconhecido
 */
export function inferDocumentsUrlFromGruposUrl(gruposPageUrl) {
  const raw = String(gruposPageUrl || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'grupos' || !parts[1]) return '';
    return new URL(`/grupos/${parts[1]}/documents/`, u.origin).href;
  } catch {
    return '';
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Raiz do repositório (pai de `src/`). */
export const projectRoot = path.join(__dirname, '..', '..');

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

/** @param {string} lockPath */
async function acquireSessionWriteLock(lockPath, opts = {}) {
  const staleMs = opts.staleMs ?? 180_000;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      await fh.writeFile(String(process.pid), 'utf8');
      return fh;
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === 'EEXIST') {
        let st = null;
        try {
          st = await fs.stat(lockPath);
        } catch {
          /* lock removido */
        }
        if (st && Date.now() - st.mtimeMs > staleMs) {
          await fs.unlink(lockPath).catch(() => {});
          continue;
        }
        await new Promise((r) => setTimeout(r, 40 + Math.random() * 120));
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Timeout de lock de sessão: ${lockPath}`);
}

/** @param {import('fs/promises').FileHandle} fh */
async function releaseSessionWriteLock(fh, lockPath) {
  await fh.close().catch(() => {});
  await fs.unlink(lockPath).catch(() => {});
}

/**
 * Escreve `session.json` de forma atómica (rename) sob lock de ficheiro,
 * para vários workers/processos não corromperem o JSON.
 */
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
  const payload = JSON.stringify({ cookies, localStorage: localStorageData }, null, 2);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const lockPath = `${filePath}.write.lock`;
  const fh = await acquireSessionWriteLock(lockPath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, payload, 'utf8');
    try {
      await fs.rename(tmp, filePath);
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === 'EPERM' || code === 'EEXIST' || code === 'EBUSY') {
        await fs.copyFile(tmp, filePath);
        await fs.unlink(tmp).catch(() => {});
      } else {
        throw e;
      }
    }
  } finally {
    await releaseSessionWriteLock(fh, lockPath);
  }
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

/**
 * Pasta onde ficam screenshot + HTML quando a autenticação falha (`DIAG_DIR`, default `diagnostics/`).
 * No CI é publicada como artifact para se perceber *o que* o portal devolveu.
 */
export const diagnosticsDir = process.env.DIAG_DIR || path.join(projectRoot, 'diagnostics');

/**
 * `wp-login.php` está atrás do Managed Challenge do Cloudflare desde maio/2026 ("Just a moment…").
 * O resto do portal (grupos, documentos, Drive) não está — logo uma sessão válida nunca vê o desafio.
 * Detectar cedo evita o erro genérico "Campos de login não encontrados".
 */
export async function isCloudflareChallenge(page) {
  return page
    .evaluate(() => {
      const title = (document.title || '').toLowerCase();
      return (
        title.includes('just a moment') ||
        title.includes('um momento') ||
        !!document.querySelector('#challenge-form, #challenge-running, #cf-challenge-running, .cf-turnstile')
      );
    })
    .catch(() => false);
}

/**
 * Grava `diagnostics/<label>-<timestamp>.{png,html}` com o estado atual da página.
 * Nunca lança: diagnóstico não pode mascarar o erro original.
 */
export async function dumpDiagnostics(page, label) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = path.join(diagnosticsDir, `${safeFileName(label)}-${stamp}`);
  try {
    await fs.mkdir(diagnosticsDir, { recursive: true });
    await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) await fs.writeFile(`${base}.html`, html, 'utf8');
    console.log(`[DIAG] url=${page.url()} → ${base}.{png,html}`);
  } catch (e) {
    console.log(`[DIAG] falhou a gravar diagnóstico: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Expiração (Date) do cookie `wordpress_logged_in_*`, ou `null` se for cookie de sessão
 * (login sem "Lembrar-me": o token vale 2 dias no servidor, mas o cookie não tem `expires`).
 * @param {Array<{ name: string; expires?: number }>} cookies
 */
export function sessionExpiry(cookies) {
  const c = (cookies || []).find((k) => k.name?.startsWith('wordpress_logged_in_'));
  if (!c || !c.expires || c.expires <= 0) return null;
  return new Date(c.expires * 1000);
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
    if (await isCloudflareChallenge(page)) {
      await dumpDiagnostics(page, 'cloudflare-challenge');
      throw new Error(
        '[LOGIN] wp-login.php protegido por Cloudflare (Managed Challenge) — automação não consegue autenticar. ' +
          'Solução: fazer login uma vez num browser visível (`npm start -- --lessons --headed --limit=1`) ' +
          'e reutilizar o session.json gerado (no CI: secret INFNET_SESSION_B64). Ver README → "Sessão e Cloudflare".',
      );
    }
    await dumpDiagnostics(page, 'login-fields-missing');
    throw new Error('Campos de login não encontrados');
  }

  await userEl.click({ clickCount: 3 });
  await userEl.type(user, { delay: 12 });
  await passEl.click({ clickCount: 3 });
  await passEl.type(pass, { delay: 12 });

  // "Lembrar-me": cookie de 14 dias em vez de 2 — é o que permite reutilizar a sessão entre execuções.
  const remember = await page.$('input#rememberme, input[name="rememberme"]');
  if (remember) {
    const checked = await remember.evaluate((el) => /** @type {HTMLInputElement} */ (el).checked);
    if (!checked) await remember.click();
  }

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
    const exp = sessionExpiry(session.cookies);
    if (exp) {
      const days = Math.round((exp.getTime() - Date.now()) / 86_400_000);
      console.log(`[SESSÃO] session.json expira em ${exp.toISOString().slice(0, 10)} (${days} dia(s))`);
      if (days <= 3) {
        console.log('::warning::[SESSÃO] expira em ≤3 dias — renovar com login visível (README → "Sessão e Cloudflare")');
      }
    } else {
      console.log('[SESSÃO] session.json sem expiração declarada (login sem "Lembrar-me"?)');
    }
  }

  await gotoUrl(page, targetUrl, settleMs);

  if (page.url().includes('wp-login.php')) {
    if (session) console.log('::warning::[SESSÃO] session.json rejeitado pelo portal — expirado ou revogado');
    if (!user || !pass) {
      throw new Error('FACULDADE_USER / FACULDADE_PASS ausentes (.env)');
    }
    console.log('[LOGIN] Tentando autenticação…');
    await login(page, user, pass);
    await gotoUrl(page, targetUrl, settleMs);
    if (page.url().includes('wp-login.php')) {
      await dumpDiagnostics(page, 'login-rejected');
      throw new Error('[LOGIN] Falha: ainda na tela de login');
    }
    console.log('[LOGIN] Sucesso');
    await saveSession(page, sessionPath);
  } else {
    console.log('[LOGIN] Sessão válida');
    // Regrava sempre: o portal pode ter renovado cookies e o CI reexporta o ficheiro para o secret.
    await saveSession(page, sessionPath);
  }
}
