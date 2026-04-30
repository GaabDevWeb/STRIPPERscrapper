import { createRequire } from 'module';

const require = createRequire(import.meta.url);

/** @typedef {{ wid: number, status: string }} WorkerRow */

function nowMs() {
  return Date.now();
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let u = 0;
  let v = n;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  const digits = v >= 100 || u === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[u]}`;
}

function formatDurationSec(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function safeOneLine(v) {
  const s = String(v ?? '');
  return s.replace(/\s+/g, ' ').trim();
}

function createNoopDashboard() {
  return {
    enabled: false,
    setTotals: () => {},
    setWorkerStatus: () => {},
    onItemDone: () => {},
    onError: () => {},
    onLog: () => {},
    captureConsole: () => () => {},
    finalizeAndPrintSummary: () => {},
    destroy: () => {},
    getSummary: () => ({
      total: 0,
      done: 0,
      bytes: 0,
      errors: 0,
      elapsedMs: 0,
    }),
  };
}

/**
 * @param {{
 *   enabled: boolean;
 *   title?: string;
 *   workers?: number;
 *   renderFps?: number;
 * }} p
 */
export function createDashboard(p) {
  const enabled = Boolean(p?.enabled);
  if (!enabled) return createNoopDashboard();

  // Lazy require (CJS) para compatibilidade ESM do projeto.
  // Se deps não estiverem instaladas, faz fallback para logs simples (não aborta o scraper).
  /** @type {any} */
  let blessed;
  /** @type {any} */
  let contrib;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    blessed = require('blessed');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    contrib = require('blessed-contrib');
  } catch (e) {
    const code =
      e && typeof e === 'object' && 'code' in e ? String(e.code) : '';
    if (code === 'MODULE_NOT_FOUND') {
      // eslint-disable-next-line no-console
      console.warn(
        '[DASHBOARD] Dependências do TUI ausentes (blessed/blessed-contrib). ' +
          'Faça `npm install` ou use `--no-dashboard`.'
      );
      return createNoopDashboard();
    }
    throw e;
  }

  const renderEveryMs = Math.max(
    50,
    Math.floor(1000 / (Number(p?.renderFps) > 0 ? Number(p.renderFps) : 10))
  );
  const workerCount = Number.isFinite(p?.workers) ? Math.max(1, p.workers) : 1;

  const startedAt = nowMs();
  let total = 0;
  let done = 0;
  let bytes = 0;
  let errorCount = 0;
  let destroyed = false;

  /** @type {Map<number, string>} */
  const workerStatus = new Map();
  for (let i = 1; i <= workerCount; i += 1) workerStatus.set(i, '—');

  let renderTimer = null;
  let dirty = true;

  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    dockBorders: true,
    title: safeOneLine(p?.title || 'StripperScrapper'),
  });

  const grid = new contrib.grid({ rows: 12, cols: 12, screen });

  const progress = grid.set(0, 0, 2, 9, contrib.gauge, {
    label: 'Progresso global',
    stroke: 'green',
    fill: 'white',
  });

  const perfBox = grid.set(0, 9, 2, 3, blessed.box, {
    label: 'Performance',
    border: { type: 'line' },
    padding: { left: 1, right: 1 },
    tags: true,
  });

  const workerTable = grid.set(2, 0, 6, 12, contrib.table, {
    label: 'Workers',
    keys: true,
    interactive: true,
    columnWidth: [10, 90],
    fg: 'white',
  });

  const log = grid.set(8, 0, 4, 12, contrib.log, {
    label: 'Logs (erros e info)',
    fg: 'white',
    selectedFg: 'white',
    keys: true,
    mouse: true,
    scrollbar: { ch: ' ', inverse: true },
    tags: true,
  });

  function computePerfText() {
    const elapsedSec = (nowMs() - startedAt) / 1000;
    const rate = elapsedSec > 0 ? bytes / elapsedSec : 0;
    const itemsPerSec = elapsedSec > 0 ? done / elapsedSec : 0;
    const etaSec =
      total > 0 && done > 0 && itemsPerSec > 0 ? (total - done) / itemsPerSec : 0;

    const lines = [];
    lines.push(`Bytes: {bold}${formatBytes(bytes)}{/bold}`);
    lines.push(`Taxa:  {bold}${formatBytes(rate)}/s{/bold}`);
    lines.push(`ETA:   {bold}${formatDurationSec(etaSec)}{/bold}`);
    lines.push(`Erros: {bold}${errorCount}{/bold}`);
    return lines.join('\n');
  }

  function computeProgressPercent() {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.floor((done / total) * 100)));
  }

  /** @returns {WorkerRow[]} */
  function computeWorkerRows() {
    const rows = [];
    for (let i = 1; i <= workerCount; i += 1) {
      rows.push({ wid: i, status: workerStatus.get(i) || '—' });
    }
    return rows;
  }

  function renderNow() {
    if (destroyed) return;
    dirty = false;

    const percent = computeProgressPercent();
    progress.setPercent(percent);
    progress.setLabel(
      `Progresso global — ${done}/${total || 0} (${percent}%)`
    );
    perfBox.setContent(computePerfText());

    const rows = computeWorkerRows();
    workerTable.setData({
      headers: ['Worker', 'Status'],
      data: rows.map((r) => [`#${r.wid}`, safeOneLine(r.status)]),
    });

    screen.render();
  }

  function scheduleRender() {
    if (destroyed) return;
    dirty = true;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (dirty) renderNow();
    }, renderEveryMs);
  }

  function onLog(level, message) {
    if (destroyed) return;
    const ts = new Date().toISOString().slice(11, 19);
    const lvl = safeOneLine(level || 'LOG').toUpperCase();
    const msg = safeOneLine(message);
    const color =
      lvl === 'ERROR' ? '{red-fg}' : lvl === 'WARN' ? '{yellow-fg}' : '{gray-fg}';
    log.log(`${color}${ts} [${lvl}]{/} ${msg}`);
    scheduleRender();
  }

  function onError(message) {
    errorCount += 1;
    onLog('ERROR', message);
  }

  function setTotals(newTotal) {
    total = Number.isFinite(newTotal) && newTotal >= 0 ? Math.floor(newTotal) : 0;
    scheduleRender();
  }

  function onItemDone(p2) {
    const count = Number.isFinite(p2?.count) ? Math.max(0, Math.floor(p2.count)) : 1;
    const b = Number.isFinite(p2?.bytes) ? Math.max(0, p2.bytes) : 0;
    done = Math.min(total || Number.MAX_SAFE_INTEGER, done + count);
    bytes += b;
    scheduleRender();
  }

  function setWorkerStatus(wid, text) {
    const id = Number(wid);
    if (!Number.isFinite(id) || id < 1) return;
    workerStatus.set(Math.floor(id), safeOneLine(text || '—'));
    scheduleRender();
  }

  function captureConsole() {
    const prev = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    console.log = (...args) => onLog('INFO', args.map(String).join(' '));
    console.warn = (...args) => onLog('WARN', args.map(String).join(' '));
    console.error = (...args) => onLog('ERROR', args.map(String).join(' '));
    return () => {
      console.log = prev.log;
      console.warn = prev.warn;
      console.error = prev.error;
    };
  }

  function getSummary() {
    const elapsedMs = nowMs() - startedAt;
    return { total, done, bytes, errors: errorCount, elapsedMs };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (renderTimer) clearTimeout(renderTimer);
    try {
      screen.destroy();
    } catch {
      // best-effort
    }
  }

  /**
   * Destrói a TUI e imprime um resumo estático no stdout.
   * @param {{
   *   ok: boolean;
   *   downloadsDir?: string;
   *   outputDir?: string;
   *   workers?: number;
   * }} final
   */
  function finalizeAndPrintSummary(final) {
    const s = getSummary();
    destroy();
    const elapsedSec = s.elapsedMs / 1000;
    const rate = elapsedSec > 0 ? s.bytes / elapsedSec : 0;
    const header = final?.ok ? '[DASHBOARD] Resumo (OK)' : '[DASHBOARD] Resumo (FALHA)';
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(header);
    // eslint-disable-next-line no-console
    console.log(`- Progresso: ${s.done}/${s.total}`);
    // eslint-disable-next-line no-console
    console.log(`- Baixado:   ${formatBytes(s.bytes)} (${formatBytes(rate)}/s)`);
    // eslint-disable-next-line no-console
    console.log(`- Erros:     ${s.errors}`);
    if (final?.workers) {
      // eslint-disable-next-line no-console
      console.log(`- Workers:   ${final.workers}`);
    }
    if (final?.downloadsDir) {
      // eslint-disable-next-line no-console
      console.log(`- Downloads: ${final.downloadsDir}`);
    }
    if (final?.outputDir && final.outputDir !== final.downloadsDir) {
      // eslint-disable-next-line no-console
      console.log(`- Output:    ${final.outputDir}`);
    }
    // eslint-disable-next-line no-console
    console.log('');
  }

  // Atalhos de teclado básicos (sem interferir com throughput).
  screen.key(['escape', 'q', 'C-c'], () => {
    onError('Interrompido pelo utilizador (Ctrl+C).');
    scheduleRender();
  });

  // Primeira renderização imediata.
  renderNow();

  return {
    enabled: true,
    setTotals,
    setWorkerStatus,
    onItemDone,
    onError,
    onLog,
    captureConsole,
    finalizeAndPrintSummary,
    destroy,
    getSummary,
  };
}

