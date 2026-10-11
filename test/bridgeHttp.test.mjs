import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridgeServer } from '../src/bridge/server.mjs';
import {
  markArtifactCompletedIfPresent,
  resolveManifestRootAndPath,
  isItemCompleted,
} from '../src/utils/downloadManifest.mjs';

async function jsonFetch(base, method, pathname, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Stripper-Token'] = token;
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

describe('bridge HTTP integration', () => {
  /** @type {string} */
  let tmp;
  /** @type {Awaited<ReturnType<typeof createBridgeServer>>} */
  let bridge;
  /** @type {string} */
  let base;
  const token = 'test-bridge-token-32chars-minimum!!';

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stripper-bridge-'));
    const downloadsDir = path.join(tmp, 'downloads');
    await fs.mkdir(downloadsDir, { recursive: true });
    bridge = await createBridgeServer({
      projectRoot: tmp,
      downloadsDir,
      tokenPath: path.join(tmp, '.bridge-token'),
      token,
      port: 0,
    });
    const addr = await bridge.listen({ port: 0 });
    assert.equal(addr.host, '127.0.0.1');
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    if (bridge) await bridge.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('GET /health returns 200 without token', async () => {
    const { status, data } = await jsonFetch(base, 'GET', '/health');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.version, 1);
    assert.ok(String(data.manifestPath).includes('manifest.json'));
  });

  it('protected route returns 401 without token', async () => {
    const { status, data } = await jsonFetch(base, 'GET', '/v1/auth/bridge');
    assert.equal(status, 401);
    assert.equal(data.ok, false);
    assert.equal(data.error, 'unauthorized');
  });

  it('GET /v1/auth/bridge ok with token', async () => {
    const { status, data } = await jsonFetch(base, 'GET', '/v1/auth/bridge', { token });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
  });

  it('discovery lessons counts with mock manifest', async () => {
    const downloadsDir = bridge.cfg.downloadsDir;
    const { manifestPath, manifestRoot } = resolveManifestRootAndPath(downloadsDir, downloadsDir);
    const doneId = 'transcript:gdrv:DONEFILE01';
    const pendingId = 'transcript:gdrv:PENDING01';
    const art = path.join(downloadsDir, 'Sec', 'aula.vtt');
    const md = path.join(downloadsDir, 'Sec', 'aula.md');
    await fs.mkdir(path.dirname(art), { recursive: true });
    await fs.writeFile(art, 'WEBVTT\n\n00:00.000 --> 00:01.000\nok\n', 'utf8');
    await fs.writeFile(md, '---\ntitle: "x"\n---\n', 'utf8');
    await markArtifactCompletedIfPresent({
      manifestPath,
      manifestRoot,
      itemId: doneId,
      kind: 'transcript',
      sourceUrl: 'https://drive.google.com/file/d/DONEFILE01/view',
      artifactAbsPath: art,
      markdownAbsPath: md,
    });

    const { status, data } = await jsonFetch(base, 'POST', '/v1/discovery/lessons', {
      token,
      body: {
        courseName: 'Disc',
        tasks: [
          {
            type: 'lesson',
            id: doneId,
            source_url: 'https://drive.google.com/file/d/DONEFILE01/view',
            title: 'done',
          },
          {
            type: 'lesson',
            id: pendingId,
            source_url: 'https://drive.google.com/file/d/PENDING01/view',
            title: 'pending',
          },
        ],
      },
    });
    assert.equal(status, 200);
    assert.equal(data.total, 2);
    assert.equal(data.completed, 1);
    assert.equal(data.pending, 1);
  });

  it('verifyArtifact pending when file missing', async () => {
    const downloadsDir = bridge.cfg.downloadsDir;
    const { manifestPath, manifestRoot } = resolveManifestRootAndPath(downloadsDir, downloadsDir);
    const ghostId = 'transcript:gdrv:GHOSTFILE1';
    // Write manifest entry pointing to missing files via mark then delete
    const art = path.join(downloadsDir, 'Ghost', 'g.vtt');
    const md = path.join(downloadsDir, 'Ghost', 'g.md');
    await fs.mkdir(path.dirname(art), { recursive: true });
    await fs.writeFile(art, 'WEBVTT\n', 'utf8');
    await fs.writeFile(md, '---\ntitle: "g"\n---\n', 'utf8');
    await markArtifactCompletedIfPresent({
      manifestPath,
      manifestRoot,
      itemId: ghostId,
      kind: 'transcript',
      sourceUrl: 'https://drive.google.com/file/d/GHOSTFILE1/view',
      artifactAbsPath: art,
      markdownAbsPath: md,
    });
    await fs.rm(art);
    await fs.rm(md);

    const completed = await isItemCompleted(manifestPath, ghostId, {
      verifyArtifact: true,
      manifestRoot,
    });
    assert.equal(completed, false);

    const { data } = await jsonFetch(base, 'POST', '/v1/discovery/lessons', {
      token,
      body: {
        tasks: [
          {
            type: 'lesson',
            id: ghostId,
            source_url: 'https://drive.google.com/file/d/GHOSTFILE1/view',
          },
        ],
      },
    });
    assert.equal(data.pending, 1);
    assert.equal(data.completed, 0);
  });

  it('jobs discover_only and cancel', async () => {
    await jsonFetch(base, 'POST', '/v1/discovery/lessons', {
      token,
      body: {
        tasks: [
          {
            type: 'lesson',
            id: 'transcript:gdrv:JOBONLY01',
            source_url: 'https://drive.google.com/file/d/JOBONLY01/view',
          },
        ],
      },
    });
    const start = await jsonFetch(base, 'POST', '/v1/jobs/start', {
      token,
      body: { scope: 'lessons', mode: 'discover_only' },
    });
    assert.equal(start.status, 200);
    assert.ok(start.data.runId);
    const view = await jsonFetch(base, 'GET', `/v1/jobs/${start.data.runId}`, { token });
    assert.equal(view.data.status, 'completed');

    const dl = await jsonFetch(base, 'POST', '/v1/jobs/start', {
      token,
      body: { scope: 'lessons', mode: 'discover_and_download' },
    });
    const cancel = await jsonFetch(base, 'POST', `/v1/jobs/${dl.data.runId}/cancel`, { token });
    assert.equal(cancel.status, 200);
    const after = await jsonFetch(base, 'GET', `/v1/jobs/${dl.data.runId}`, { token });
    assert.equal(after.data.status, 'cancelled');
  });

  it('session_expired pauses running job (paused_auth)', async () => {
    const id = 'transcript:gdrv:PAUSEAUTH01';
    await jsonFetch(base, 'POST', '/v1/discovery/lessons', {
      token,
      body: {
        tasks: [
          {
            type: 'lesson',
            id,
            source_url: 'https://drive.google.com/file/d/PAUSEAUTH01/view',
            title: 'pause',
          },
        ],
      },
    });
    const start = await jsonFetch(base, 'POST', '/v1/jobs/start', {
      token,
      body: { scope: 'lessons', mode: 'discover_and_download', ignoreManifest: true },
    });
    const localPath = path.join(tmp, 'login-as-vtt.html');
    await fs.writeFile(
      localPath,
      '<!DOCTYPE html><html><body><form action="/wp-login.php"><input name="log"/><input name="pwd"/></form></body></html>',
      'utf8'
    );
    const art = await jsonFetch(base, 'POST', `/v1/tasks/${encodeURIComponent(id)}/artifact`, {
      token,
      body: {
        id,
        type: 'lesson',
        localPath,
        runId: start.data.runId,
        source_url: 'https://drive.google.com/file/d/PAUSEAUTH01/view',
        title: 'pause',
        metadata: { accordionTitle: 'X' },
      },
    });
    assert.equal(art.status, 409);
    assert.equal(art.data.errorKind, 'session_expired');
    const view = await jsonFetch(base, 'GET', `/v1/jobs/${start.data.runId}`, { token });
    assert.equal(view.data.status, 'paused_auth');
  });

  it('successful lesson artifact ingest + markdown', async () => {
    const localPath = path.join(tmp, 'incoming.vtt');
    await fs.writeFile(localPath, 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello\n', 'utf8');
    const id = 'transcript:gdrv:INGESTOK01';
    const { status, data } = await jsonFetch(base, 'POST', `/v1/tasks/${encodeURIComponent(id)}/artifact`, {
      token,
      body: {
        id,
        type: 'lesson',
        localPath,
        source_url: 'https://drive.google.com/file/d/INGESTOK01/view',
        title: 'Aula Ingest',
        course: 'Curso',
        metadata: { accordionTitle: 'Modulo 1' },
      },
    });
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.result, 'completed');
    assert.ok(data.artifactRelPath);
    assert.ok(data.markdownRelPath);
    const mdAbs = path.join(bridge.cfg.downloadsDir, data.markdownRelPath);
    const md = await fs.readFile(mdAbs, 'utf8');
    assert.match(md, /title:/);
    assert.match(md, /source_url:/);
    assert.match(md, /transcript_file:/);
    assert.match(md, /downloaded_at:/);
  });
});
