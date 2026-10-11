/**
 * UI operacional mínima — auth, bridge, discovery, downloads, progresso.
 */

const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) resolve({ ok: false, error: err.message });
      else resolve(response || { ok: false, error: 'empty_response' });
    });
  });
}

function renderAuth(state) {
  const status = state?.status || 'NOT_AUTHENTICATED';
  const el = $('authStatus');
  el.textContent = status;
  el.className = `status ${status}`;
  $('authDetail').textContent = state?.detail || (state?.checkedAt ? `checked ${state.checkedAt}` : '');
  $('reauthHint').classList.toggle('hidden', status !== 'SESSION_EXPIRED');
}

function renderProgress(p = {}, meta = {}) {
  for (const k of ['completed', 'skipped', 'failed', 'dlq', 'pending']) {
    const span = document.querySelector(`[data-k="${k}"]`);
    if (span) span.textContent = String(p[k] ?? 0);
  }
  const bits = [];
  if (meta.runId) bits.push(`runId: ${meta.runId}`);
  if (meta.running) bits.push('running');
  $('runMeta').textContent = bits.join(' · ');
}

function collectSettingsFromForm() {
  return {
    bridgeBaseUrl: $('bridgeBaseUrl').value.trim(),
    bridgeToken: $('bridgeToken').value.trim(),
    classesUrl: $('classesUrl').value.trim(),
    documentsUrl: $('documentsUrl').value.trim(),
    scope: $('scope').value,
    mode: $('mode').value,
    ignoreManifest: $('ignoreManifest').checked,
    failFast: $('failFast').checked,
  };
}

function fillForm(settings) {
  if (!settings) return;
  $('bridgeBaseUrl').value = settings.bridgeBaseUrl || 'http://127.0.0.1:8787';
  $('bridgeToken').value = settings.bridgeToken || '';
  $('classesUrl').value = settings.classesUrl || '';
  $('documentsUrl').value = settings.documentsUrl || '';
  $('scope').value = settings.scope || 'all';
  $('mode').value = settings.mode || 'discover_and_download';
  $('ignoreManifest').checked = !!settings.ignoreManifest;
  $('failFast').checked = !!settings.failFast;
}

async function refreshAll() {
  const auth = await send('GET_AUTH_STATE');
  if (auth.ok) renderAuth(auth.state);
  const settings = await send('GET_SETTINGS');
  if (settings.ok) fillForm(settings.settings);
  const prog = await send('GET_PROGRESS');
  if (prog.ok) renderProgress(prog.progress, { runId: prog.runId, running: prog.running });
}

async function openLogsSidePanel() {
  // Tem de correr no gesto do utilizador (popup), NÃO no service worker.
  const win = await chrome.windows.getCurrent();
  if (chrome.sidePanel?.setOptions) {
    await chrome.sidePanel.setOptions({
      path: 'sidepanel/sidepanel.html',
      enabled: true,
    });
  }
  await chrome.sidePanel.open({ windowId: win.id });
}

function openLogsTab() {
  chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
}

$('btnOpenLogs').addEventListener('click', async () => {
  $('logsMsg').textContent = 'A abrir painel…';
  try {
    await openLogsSidePanel();
    $('logsMsg').textContent = 'Painel aberto à direita.';
  } catch (e) {
    $('logsMsg').textContent = `Painel falhou (${e?.message || e}). A abrir aba…`;
    openLogsTab();
  }
});

$('btnOpenLogsTab').addEventListener('click', () => {
  openLogsTab();
});

$('btnRefreshAuth').addEventListener('click', async () => {
  const r = await send('GET_AUTH_STATE');
  if (r.ok) renderAuth(r.state);
});

$('btnVerifyAuth').addEventListener('click', async () => {
  $('authDetail').textContent = 'A verificar…';
  const r = await send('VERIFY_AUTH');
  if (r.ok) renderAuth(r.state);
  else $('authDetail').textContent = r.error || 'Falha';
});

$('btnSaveBridge').addEventListener('click', async () => {
  const r = await send('SAVE_SETTINGS', {
    bridgeBaseUrl: $('bridgeBaseUrl').value.trim(),
    bridgeToken: $('bridgeToken').value.trim(),
  });
  $('bridgeMsg').textContent = r.ok ? 'Bridge guardado.' : r.error || 'Erro';
});

$('btnHealth').addEventListener('click', async () => {
  await send('SAVE_SETTINGS', {
    bridgeBaseUrl: $('bridgeBaseUrl').value.trim(),
    bridgeToken: $('bridgeToken').value.trim(),
  });
  const r = await send('BRIDGE_HEALTH');
  if (!r.ok) {
    $('bridgeMsg').textContent = `Health falhou: ${r.error || 'offline'}`;
    return;
  }
  const authOk = r.auth?.ok ? 'token OK' : `token: ${r.auth?.error || 'fail'}`;
  $('bridgeMsg').textContent = `Health OK · ${authOk}`;
});

$('btnSaveSettings').addEventListener('click', async () => {
  const r = await send('SAVE_SETTINGS', collectSettingsFromForm());
  $('actionMsg').textContent = r.ok ? 'Settings guardados.' : r.error || 'Erro';
});

$('btnDiscover').addEventListener('click', async () => {
  $('actionMsg').textContent = 'Discovery…';
  await send('SAVE_SETTINGS', collectSettingsFromForm());
  const r = await send('DISCOVER', { scope: $('scope').value });
  if (!r.ok) {
    $('actionMsg').textContent = r.error || 'Discovery falhou';
    if (r.errorKind === 'session_expired') {
      const a = await send('GET_AUTH_STATE');
      if (a.ok) renderAuth(a.state);
    }
    return;
  }
  const lc = r.lessons?.payload?.tasks?.length ?? 0;
  const dc = r.documents?.payload?.tasks?.length ?? 0;
  const bridgeNote = [
    r.lessons?.bridge?.offline ? 'lessons bridge offline' : null,
    r.documents?.bridge?.offline ? 'docs bridge offline' : null,
  ]
    .filter(Boolean)
    .join('; ');
  $('actionMsg').textContent = `Discover OK — lessons: ${lc}, docs: ${dc}${bridgeNote ? ` (${bridgeNote})` : ''}`;
});

$('btnStart').addEventListener('click', async () => {
  // Este botão SEMPRE baixa — discover_only é só para o botão Discover.
  $('mode').value = 'discover_and_download';
  $('actionMsg').textContent = 'A iniciar downloads…';
  await send('SAVE_SETTINGS', collectSettingsFromForm());
  const r = await send('START_DOWNLOAD', {
    scope: $('scope').value,
    mode: 'discover_and_download',
    ignoreManifest: $('ignoreManifest').checked,
    failFast: $('failFast').checked,
  });
  if (!r.ok) {
    $('actionMsg').textContent = r.error || 'Start falhou';
    return;
  }
  if (r.mode === 'discover_only') {
    const lc = r.lessons?.payload?.tasks?.length ?? 0;
    const dc = r.documents?.payload?.tasks?.length ?? 0;
    $('actionMsg').textContent = `ATENÇÃO: ficou em discover_only — lessons: ${lc}, docs: ${dc}. Nada foi baixado.`;
    return;
  }
  $('actionMsg').textContent = `A baixar… run ${r.runId || '—'} · queued ${r.queued ?? 0}`;
  renderProgress({ pending: r.queued ?? 0, completed: 0, skipped: 0, failed: 0, dlq: 0 }, {
    runId: r.runId,
    running: true,
  });
});

$('btnCancel').addEventListener('click', async () => {
  const r = await send('CANCEL_RUN');
  $('actionMsg').textContent = r.ok ? 'Cancel pedido.' : r.error || 'Erro';
  if (r.progress) renderProgress(r.progress);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'AUTH_STATE_CHANGED') renderAuth(msg.payload);
  if (msg?.type === 'RUN_PROGRESS') {
    renderProgress(msg.payload, { runId: msg.payload?.runId, running: msg.payload?.running });
  }
  if (msg?.type === 'RUN_FINISHED') {
    renderProgress(msg.payload?.progress || {}, { running: false });
    $('actionMsg').textContent = msg.payload?.paused_auth
      ? 'Pausado — reautentique (SESSION_EXPIRED).'
      : msg.payload?.cancelled
        ? 'Cancelado.'
        : 'Run terminado.';
    if (msg.payload?.paused_auth) send('GET_AUTH_STATE').then((a) => a.ok && renderAuth(a.state));
  }
});

refreshAll();
