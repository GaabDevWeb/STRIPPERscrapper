import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateBinaryFile } from '../src/utils/integrity.mjs';
import { classifyHtmlArtifact, processArtifact } from '../src/bridge/ingest.mjs';
import {
  isItemCompleted,
  loadManifest,
  resolveManifestRootAndPath,
} from '../src/utils/downloadManifest.mjs';

describe('integrity / HTML session rejection', () => {
  /** @type {string} */
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stripper-integrity-'));
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('validateBinaryFile rejects HTML', async () => {
    const p = path.join(tmp, 'fake.vtt');
    await fs.writeFile(p, '<!DOCTYPE html><html><body>login</body></html>\n', 'utf8');
    await assert.rejects(() => validateBinaryFile({ filePath: p }), /parece HTML/i);
  });

  it('classifyHtmlArtifact detects session_expired login page', async () => {
    const p = path.join(tmp, 'login.html');
    await fs.writeFile(
      p,
      '<!DOCTYPE html><html><body><form action="wp-login.php"><input id="user_login"/><input id="user_pass"/></form></body></html>',
      'utf8'
    );
    assert.equal(await classifyHtmlArtifact(p), 'session_expired');
  });

  it('session_expired does not mark completed', async () => {
    const downloadsDir = path.join(tmp, 'downloads');
    await fs.mkdir(downloadsDir, { recursive: true });
    const localPath = path.join(tmp, 'session.vtt');
    await fs.writeFile(
      localPath,
      '<!DOCTYPE html><html><head></head><body class="login">wp-login.php form<input name="log"/><input name="pwd"/></body></html>',
      'utf8'
    );
    const id = 'transcript:gdrv:SESSIONTEST1';
    const outcome = await processArtifact(
      { downloadsDir, documentsDir: path.join(downloadsDir, 'documents') },
      {
        id,
        type: 'lesson',
        localPath,
        source_url: 'https://drive.google.com/file/d/SESSIONTEST1/view',
        title: 'Aula sessão',
        metadata: { accordionTitle: 'Secção Teste' },
      }
    );
    assert.equal(outcome.httpStatus, 409);
    assert.equal(outcome.body.errorKind, 'session_expired');
    assert.equal(outcome.body.ok, false);
    assert.equal(outcome.body.retryable, false);
    assert.equal(outcome.body.dlq, false);

    const { manifestPath, manifestRoot } = resolveManifestRootAndPath(downloadsDir, downloadsDir);
    const completed = await isItemCompleted(manifestPath, id, {
      verifyArtifact: true,
      manifestRoot,
    });
    assert.equal(completed, false);
    const doc = await loadManifest(manifestPath);
    // session_expired não queima DLQ — item fica pending para reauth
    assert.equal(doc.entries[id], undefined);
  });

  it('integrity error does not DLQ before attempt 3; DLQ on attempt 3', async () => {
    const downloadsDir = path.join(tmp, 'downloads-dlq');
    await fs.mkdir(downloadsDir, { recursive: true });
    const localPath = path.join(tmp, 'empty.bin');
    await fs.writeFile(localPath, Buffer.alloc(0));
    const id = 'transcript:gdrv:EMPTYDLQ1';
    const base = {
      id,
      type: 'lesson',
      localPath,
      source_url: 'https://drive.google.com/file/d/EMPTYDLQ1/view',
      title: 'Vazio',
      metadata: { accordionTitle: 'Secção' },
    };
    const r1 = await processArtifact(
      { downloadsDir, documentsDir: path.join(downloadsDir, 'documents') },
      { ...base, attempt: 1 }
    );
    assert.equal(r1.body.result, 'error');
    assert.equal(r1.body.retryable, true);
    assert.equal(r1.body.dlq, false);
    let doc = await loadManifest(path.join(downloadsDir, 'manifest.json'));
    assert.equal(doc.entries[id], undefined);

    const r3 = await processArtifact(
      { downloadsDir, documentsDir: path.join(downloadsDir, 'documents') },
      { ...base, attempt: 3 }
    );
    assert.equal(r3.body.result, 'error');
    assert.equal(r3.body.dlq, true);
    doc = await loadManifest(path.join(downloadsDir, 'manifest.json'));
    assert.equal(doc.entries[id]?.status, 'error');
    assert.equal(doc.entries[id]?.attempts, 3);
  });
});
