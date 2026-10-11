/**
 * Estado em memória: discovery cache + runs + eventos.
 */

import crypto from 'crypto';

/**
 * @typedef {'lesson' | 'document'} TaskType
 * @typedef {'running' | 'paused_auth' | 'cancelled' | 'completed' | 'failed'} RunStatus
 * @typedef {'pending' | 'in_flight' | 'completed' | 'skipped' | 'error' | 'dlq'} TaskRuntimeStatus
 */

/**
 * @typedef {object} DiscoveryTask
 * @property {string} id
 * @property {TaskType} type
 * @property {string} [title]
 * @property {string} [source_url]
 * @property {string} [download_url]
 * @property {string} [course]
 * @property {number} [domIndex]
 * @property {string} [path]
 * @property {string} [filename]
 * @property {string} [extension]
 * @property {object} [metadata]
 * @property {TaskRuntimeStatus} [runtimeStatus]
 */

/**
 * @typedef {object} RunRecord
 * @property {string} runId
 * @property {'lessons' | 'docs' | 'all'} scope
 * @property {'discover_only' | 'discover_and_download'} mode
 * @property {boolean} ignoreManifest
 * @property {boolean} failFast
 * @property {number | null} limit
 * @property {RunStatus} status
 * @property {{ completed: number, skipped: number, failed: number, dlq: number, pending: number }} progress
 * @property {string[]} taskIds
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export function createBridgeState() {
  /** @type {Map<string, DiscoveryTask>} */
  const tasksById = new Map();
  /** @type {Map<string, RunRecord>} */
  const runs = new Map();
  /** @type {object[]} */
  const events = [];
  /** @type {{ lessons: object | null, documents: object | null }} */
  const lastDiscovery = { lessons: null, documents: null };

  return {
    tasksById,
    runs,
    events,
    lastDiscovery,

    /** @param {DiscoveryTask[]} tasks */
    upsertTasks(tasks) {
      for (const t of tasks) {
        if (!t?.id) continue;
        const prev = tasksById.get(t.id);
        tasksById.set(t.id, {
          ...prev,
          ...t,
          runtimeStatus: prev?.runtimeStatus || 'pending',
        });
      }
    },

    newRunId() {
      return `run_${crypto.randomBytes(8).toString('hex')}`;
    },

    /**
     * @param {Omit<RunRecord, 'runId' | 'createdAt' | 'updatedAt' | 'progress'> & { progress?: RunRecord['progress'] }} partial
     */
    createRun(partial) {
      const now = new Date().toISOString();
      /** @type {RunRecord} */
      const run = {
        runId: this.newRunId(),
        scope: partial.scope,
        mode: partial.mode,
        ignoreManifest: !!partial.ignoreManifest,
        failFast: !!partial.failFast,
        limit: partial.limit ?? null,
        status: partial.status,
        progress: partial.progress || {
          completed: 0,
          skipped: 0,
          failed: 0,
          dlq: 0,
          pending: 0,
        },
        taskIds: partial.taskIds || [],
        createdAt: now,
        updatedAt: now,
      };
      runs.set(run.runId, run);
      return run;
    },

    /** @param {string} runId */
    getRun(runId) {
      return runs.get(runId) || null;
    },

    /** @param {string} runId @param {Partial<RunRecord>} patch */
    updateRun(runId, patch) {
      const run = runs.get(runId);
      if (!run) return null;
      Object.assign(run, patch, { updatedAt: new Date().toISOString() });
      return run;
    },

    /** @param {object} evt */
    pushEvent(evt) {
      events.push({ ...evt, receivedAt: new Date().toISOString() });
      if (events.length > 500) events.splice(0, events.length - 500);
    },
  };
}
