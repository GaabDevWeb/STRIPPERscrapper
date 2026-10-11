/**
 * Jobs: start/cancel/status — extensão conduz downloads; core agrega progresso.
 * SESSION_EXPIRED → paused_auth (sem retry infinito).
 */
import path from 'path';
import {
  resolveManifestRootAndPath,
  isItemCompleted,
  loadManifest,
} from '../utils/downloadManifest.mjs';
import { withRetries } from '../utils/retry.mjs';

export { withRetries };

/**
 * @param {import('./state.mjs').createBridgeState extends Function ? any : never} state
 * @param {object} cfg
 * @param {object} body
 */
export async function startJob(state, cfg, body = {}) {
  const scope = ['lessons', 'docs', 'all'].includes(body.scope) ? body.scope : 'all';
  const mode =
    body.mode === 'discover_only' || body.mode === 'discover_and_download'
      ? body.mode
      : 'discover_and_download';
  const ignoreManifest = !!body.ignoreManifest;
  const failFast = !!body.failFast;
  const limit =
    body.limit == null || body.limit === ''
      ? null
      : Number.isFinite(Number(body.limit))
        ? Math.max(0, Number(body.limit))
        : null;

  const downloadsDir = cfg.downloadsDir;
  const documentsDir = cfg.documentsDir || path.join(downloadsDir, 'documents');

  /** @type {import('./state.mjs').DiscoveryTask[]} */
  const all = [...state.tasksById.values()];
  let scoped = all.filter((t) => {
    if (scope === 'lessons') return t.type === 'lesson';
    if (scope === 'docs') return t.type === 'document';
    return true;
  });

  let skipped = 0;
  /** @type {string[]} */
  const pendingIds = [];

  for (const t of scoped) {
    const { manifestPath, manifestRoot } = resolveManifestRootAndPath(
      downloadsDir,
      t.type === 'document' ? documentsDir : downloadsDir
    );
    if (
      !ignoreManifest &&
      (await isItemCompleted(manifestPath, t.id, { verifyArtifact: true, manifestRoot }))
    ) {
      skipped++;
      t.runtimeStatus = 'skipped';
      continue;
    }
    pendingIds.push(t.id);
    t.runtimeStatus = 'pending';
  }

  if (limit != null) {
    pendingIds.splice(limit);
  }

  if (mode === 'discover_only') {
    const run = state.createRun({
      scope,
      mode,
      ignoreManifest,
      failFast,
      limit,
      status: 'completed',
      taskIds: pendingIds,
      progress: {
        completed: 0,
        skipped,
        failed: 0,
        dlq: 0,
        pending: pendingIds.length,
      },
    });
    return { ok: true, runId: run.runId, queued: pendingIds.length, run };
  }

  const run = state.createRun({
    scope,
    mode,
    ignoreManifest,
    failFast,
    limit,
    status: 'running',
    taskIds: pendingIds,
    progress: {
      completed: 0,
      skipped,
      failed: 0,
      dlq: 0,
      pending: pendingIds.length,
    },
  });

  return { ok: true, runId: run.runId, queued: pendingIds.length, run };
}

/**
 * @param {ReturnType<import('./state.mjs').createBridgeState>} state
 * @param {string} runId
 * @param {number} [nextLimit=10]
 */
export function getJobView(state, runId, nextLimit = 10) {
  const run = state.getRun(runId);
  if (!run) return null;

  /** @type {object[]} */
  const nextTasks = [];
  if (run.status === 'running') {
    for (const id of run.taskIds) {
      if (nextTasks.length >= nextLimit) break;
      const t = state.tasksById.get(id);
      if (!t) continue;
      if (t.runtimeStatus === 'pending' || t.runtimeStatus === 'in_flight') {
        nextTasks.push({
          id: t.id,
          type: t.type,
          title: t.title,
          source_url: t.source_url,
          download_url: t.download_url || t.source_url,
          course: t.course,
          domIndex: t.domIndex,
          path: t.path,
          filename: t.filename,
          extension: t.extension,
          metadata: t.metadata || {},
        });
      }
    }
  }

  return {
    runId: run.runId,
    status: run.status,
    progress: { ...run.progress },
    nextTasks,
  };
}

/**
 * @param {ReturnType<import('./state.mjs').createBridgeState>} state
 * @param {string} runId
 */
export function cancelJob(state, runId) {
  const run = state.getRun(runId);
  if (!run) return null;
  if (run.status === 'completed' || run.status === 'cancelled') {
    return state.updateRun(runId, { status: 'cancelled' });
  }
  for (const id of run.taskIds) {
    const t = state.tasksById.get(id);
    if (t && (t.runtimeStatus === 'pending' || t.runtimeStatus === 'in_flight')) {
      t.runtimeStatus = 'error';
    }
  }
  return state.updateRun(runId, {
    status: 'cancelled',
    progress: {
      ...run.progress,
      pending: 0,
    },
  });
}

/**
 * Actualiza contadores do run activo após ingest de artefacto.
 * @param {ReturnType<import('./state.mjs').createBridgeState>} state
 * @param {string | null | undefined} runId
 * @param {string} taskId
 * @param {{ result: string, errorKind?: string | null }} outcome
 */
export function applyArtifactToRuns(state, runId, taskId, outcome) {
  const runs = runId
    ? [state.getRun(runId)].filter(Boolean)
    : [...state.runs.values()].filter((r) => r.status === 'running' || r.status === 'paused_auth');

  for (const run of runs) {
    if (!run.taskIds.includes(taskId) && runId) {
      /* allow explicit runId even if not listed */
    } else if (!run.taskIds.includes(taskId) && !runId) {
      continue;
    }

    const t = state.tasksById.get(taskId);
    const progress = { ...run.progress };

    if (outcome.errorKind === 'session_expired') {
      if (t) t.runtimeStatus = 'error';
      state.updateRun(run.runId, { status: 'paused_auth', progress });
      continue;
    }

    if (outcome.result === 'completed') {
      if (t) t.runtimeStatus = 'completed';
      progress.completed += 1;
      progress.pending = Math.max(0, progress.pending - 1);
    } else if (outcome.result === 'skipped') {
      if (t) t.runtimeStatus = 'skipped';
      progress.skipped += 1;
      progress.pending = Math.max(0, progress.pending - 1);
    } else if (outcome.result === 'error') {
      if (t) t.runtimeStatus = 'error';
      progress.failed += 1;
      if (outcome.errorKind && ['integrity', 'html', 'unknown'].includes(outcome.errorKind)) {
        /* DLQ lógica após falha final no manifest (markArtifactError) */
        progress.dlq += 1;
      }
      progress.pending = Math.max(0, progress.pending - 1);
      if (run.failFast) {
        state.updateRun(run.runId, { status: 'failed', progress });
        continue;
      }
    }

    const status =
      progress.pending === 0 && run.status === 'running' ? 'completed' : run.status;
    state.updateRun(run.runId, { status, progress });
  }
}

/**
 * Contagens discovery × manifest.
 * @param {object} cfg
 * @param {import('./state.mjs').DiscoveryTask[]} tasks
 * @param {boolean} [ignoreManifest]
 */
export async function countAgainstManifest(cfg, tasks, ignoreManifest = false) {
  const downloadsDir = cfg.downloadsDir;
  const documentsDir = cfg.documentsDir || path.join(downloadsDir, 'documents');
  let pending = 0;
  let completed = 0;
  let error = 0;

  for (const t of tasks) {
    const { manifestPath, manifestRoot } = resolveManifestRootAndPath(
      downloadsDir,
      t.type === 'document' ? documentsDir : downloadsDir
    );
    const doc = await loadManifest(manifestPath);
    const entry = doc.entries[t.id];
    if (!ignoreManifest && entry?.status === 'error') {
      error++;
      continue;
    }
    if (
      !ignoreManifest &&
      (await isItemCompleted(manifestPath, t.id, { verifyArtifact: true, manifestRoot }))
    ) {
      completed++;
    } else {
      pending++;
    }
  }

  return {
    ok: true,
    total: tasks.length,
    pending,
    completed,
    error,
  };
}

/**
 * Summary do manifest em disco.
 * @param {object} cfg
 */
export async function manifestSummary(cfg) {
  const downloadsDir = cfg.downloadsDir;
  const { manifestPath } = resolveManifestRootAndPath(downloadsDir, downloadsDir);
  const doc = await loadManifest(manifestPath);
  let completed = 0;
  let error = 0;
  for (const e of Object.values(doc.entries || {})) {
    if (e.status === 'completed') completed++;
    else if (e.status === 'error') error++;
  }
  return {
    version: doc.version || 1,
    updatedAt: doc.updatedAt || '',
    counts: {
      completed,
      error,
      pendingUnknown: 0,
    },
  };
}
