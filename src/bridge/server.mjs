/**
 * HTTP Core Bridge — bind exclusivo 127.0.0.1 + X-Stripper-Token.
 * Logs sem cookies/tokens/passwords.
 */
import http from 'http';
import { URL } from 'url';
import { loadBridgeConfig } from './config.mjs';
import { loadOrCreateBridgeToken, tokensMatch } from './token.mjs';
import { createBridgeState } from './state.mjs';
import { processArtifact } from './ingest.mjs';
import {
  startJob,
  getJobView,
  cancelJob,
  applyArtifactToRuns,
  countAgainstManifest,
  manifestSummary,
} from './jobs.mjs';
import { resolveManifestRootAndPath } from '../utils/downloadManifest.mjs';
import { ensureDir } from '../utils/infnetShared.mjs';

/**
 * @param {http.IncomingMessage} req
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function getTokenHeader(req) {
  const h = req.headers['x-stripper-token'];
  if (Array.isArray(h)) return h[0] || '';
  return h || '';
}

/**
 * @param {object} [opts]
 * @param {Partial<ReturnType<typeof loadBridgeConfig>> & { token?: string, state?: ReturnType<typeof createBridgeState> }} [opts]
 */
export async function createBridgeServer(opts = {}) {
  const cfg = loadBridgeConfig(opts);
  const token = opts.token || (await loadOrCreateBridgeToken(cfg.tokenPath));
  const state = opts.state || createBridgeState();

  await ensureDir(cfg.downloadsDir);
  await ensureDir(cfg.documentsDir);

  const { manifestPath } = resolveManifestRootAndPath(cfg.downloadsDir, cfg.downloadsDir);

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `${cfg.host}:${cfg.port}`;
      const url = new URL(req.url || '/', `http://${host}`);
      const method = (req.method || 'GET').toUpperCase();
      const pathname = url.pathname;

      // Auth: /health is optional; all /v1/* require token
      const needsAuth = pathname.startsWith('/v1/');
      if (needsAuth && !tokensMatch(getTokenHeader(req), token)) {
        sendJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      if (method === 'GET' && pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          version: cfg.bridgeVersion,
          manifestPath,
        });
        return;
      }

      if (method === 'GET' && pathname === '/v1/auth/bridge') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (method === 'POST' && pathname === '/v1/discovery/lessons') {
        let raw;
        try {
          raw = await readBody(req, cfg.maxBodyBytes);
        } catch (e) {
          if (e && e.code === 'PAYLOAD_TOO_LARGE') {
            sendJson(res, 413, { ok: false, error: 'payload_too_large' });
            return;
          }
          throw e;
        }
        let body;
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        if (!Array.isArray(body.tasks)) {
          sendJson(res, 400, { ok: false, error: 'tasks_required' });
          return;
        }
        const tasks = body.tasks
          .filter((t) => t && t.id)
          .map((t) => ({
            id: String(t.id),
            type: 'lesson',
            domIndex: t.domIndex,
            title: t.title,
            source_url: t.source_url || t.download_url || '',
            download_url: t.download_url || t.source_url || '',
            course: t.course || body.courseName || '',
            metadata: t.metadata || {},
          }));
        state.upsertTasks(tasks);
        state.lastDiscovery.lessons = {
          classesUrl: body.classesUrl,
          courseName: body.courseName,
          discoveredAt: body.discoveredAt || new Date().toISOString(),
          count: tasks.length,
        };
        const counts = await countAgainstManifest(cfg, tasks, !!body.ignoreManifest);
        sendJson(res, 200, counts);
        return;
      }

      if (method === 'POST' && pathname === '/v1/discovery/documents') {
        let raw;
        try {
          raw = await readBody(req, cfg.maxBodyBytes);
        } catch (e) {
          if (e && e.code === 'PAYLOAD_TOO_LARGE') {
            sendJson(res, 413, { ok: false, error: 'payload_too_large' });
            return;
          }
          throw e;
        }
        let body;
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        if (!Array.isArray(body.tasks)) {
          sendJson(res, 400, { ok: false, error: 'tasks_required' });
          return;
        }
        const tasks = body.tasks
          .filter((t) => t && t.id)
          .map((t) => ({
            id: String(t.id),
            type: 'document',
            path: t.path,
            filename: t.filename,
            extension: t.extension,
            title: t.title || t.filename,
            source_url: t.source_url || '',
            metadata: t.metadata || {},
          }));
        state.upsertTasks(tasks);
        state.lastDiscovery.documents = {
          documentsUrl: body.documentsUrl,
          discoveredAt: body.discoveredAt || new Date().toISOString(),
          count: tasks.length,
        };
        const counts = await countAgainstManifest(cfg, tasks, !!body.ignoreManifest);
        sendJson(res, 200, counts);
        return;
      }

      if (method === 'POST' && pathname === '/v1/jobs/start') {
        let raw;
        try {
          raw = await readBody(req, cfg.maxBodyBytes);
        } catch (e) {
          if (e && e.code === 'PAYLOAD_TOO_LARGE') {
            sendJson(res, 413, { ok: false, error: 'payload_too_large' });
            return;
          }
          throw e;
        }
        let body;
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        const result = await startJob(state, cfg, body || {});
        sendJson(res, 200, {
          ok: true,
          runId: result.runId,
          queued: result.queued,
        });
        return;
      }

      const jobMatch = pathname.match(/^\/v1\/jobs\/([^/]+)$/);
      if (method === 'GET' && jobMatch) {
        const view = getJobView(state, decodeURIComponent(jobMatch[1]));
        if (!view) {
          sendJson(res, 404, { ok: false, error: 'run_not_found' });
          return;
        }
        sendJson(res, 200, view);
        return;
      }

      const cancelMatch = pathname.match(/^\/v1\/jobs\/([^/]+)\/cancel$/);
      if (method === 'POST' && cancelMatch) {
        const run = cancelJob(state, decodeURIComponent(cancelMatch[1]));
        if (!run) {
          sendJson(res, 404, { ok: false, error: 'run_not_found' });
          return;
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      const artifactMatch = pathname.match(/^\/v1\/tasks\/([^/]+)\/artifact$/);
      if (method === 'POST' && artifactMatch) {
        const taskId = decodeURIComponent(artifactMatch[1]);
        let raw;
        try {
          raw = await readBody(req, cfg.maxBodyBytes);
        } catch (e) {
          if (e && e.code === 'PAYLOAD_TOO_LARGE') {
            sendJson(res, 413, { ok: false, error: 'payload_too_large' });
            return;
          }
          throw e;
        }
        let body;
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        if (!body.id) body.id = taskId;
        const outcome = await processArtifact(cfg, body, taskId);
        applyArtifactToRuns(state, body.runId || null, body.id || taskId, {
          result: outcome.body.result,
          errorKind: outcome.body.errorKind,
        });
        sendJson(res, outcome.httpStatus, outcome.body);
        return;
      }

      if (method === 'GET' && pathname === '/v1/manifest/summary') {
        const summary = await manifestSummary(cfg);
        sendJson(res, 200, summary);
        return;
      }

      if (method === 'POST' && pathname === '/v1/events') {
        let raw;
        try {
          raw = await readBody(req, cfg.maxBodyBytes);
        } catch (e) {
          if (e && e.code === 'PAYLOAD_TOO_LARGE') {
            sendJson(res, 413, { ok: false, error: 'payload_too_large' });
            return;
          }
          throw e;
        }
        let body;
        try {
          body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: 'invalid_json' });
          return;
        }
        // Strip sensitive keys if present
        const safe = { ...body };
        delete safe.token;
        delete safe.password;
        delete safe.cookies;
        delete safe.localStorage;
        delete safe.Authorization;
        delete safe.authorization;
        state.pushEvent(safe);
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Never log headers that may contain token
      console.error('[bridge] internal error:', msg);
      sendJson(res, 500, {
        ok: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'internal error',
        },
      });
    }
  });

  return {
    server,
    cfg,
    token,
    state,
    /**
     * @param {{ port?: number, host?: string }} [listenOpts]
     * @returns {Promise<{ host: string, port: number }>}
     */
    async listen(listenOpts = {}) {
      const host = listenOpts.host || cfg.host;
      if (host !== '127.0.0.1') {
        throw new Error('Bridge MUST bind only to 127.0.0.1');
      }
      const port = listenOpts.port != null ? listenOpts.port : cfg.port;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : port;
      return { host, port: boundPort };
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

export function redactForLog(value) {
  if (value == null) return value;
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…(${s.length})`;
}
