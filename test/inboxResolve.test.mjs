import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolveArtifactSourcePath } from '../src/bridge/ingest.mjs';

describe('inbox artifact resolve (extension contract)', () => {
  /** @type {string} */
  let tmp;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'stripper-inbox-'));
    await fs.mkdir(path.join(tmp, 'StripperScrapper', 'documents', 'Fundamentos_C#'), {
      recursive: true,
    });
    await fs.writeFile(path.join(tmp, 'StripperScrapper', 'aula.bin'), Buffer.from('ok-data'));
    await fs.writeFile(
      path.join(tmp, 'StripperScrapper', 'documents', 'Fundamentos_C#', 'lista.pdf'),
      Buffer.from('%PDF-ok')
    );
  });

  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('resolves filename relative to inboxDir when localPath null', async () => {
    const r = await resolveArtifactSourcePath(
      { inboxDir: tmp },
      { localPath: null, filename: 'StripperScrapper/aula.bin' }
    );
    assert.ok(r.localPath);
    assert.equal(path.basename(r.localPath), 'aula.bin');
  });

  it('resolves document under StripperScrapper/documents/ (layout ISS)', async () => {
    const r = await resolveArtifactSourcePath(
      { inboxDir: tmp },
      {
        localPath: null,
        filename: 'StripperScrapper/documents/Fundamentos_C#/lista.pdf',
      }
    );
    assert.ok(r.localPath);
    assert.match(r.localPath, /documents[/\\]Fundamentos_C#[/\\]lista\.pdf$/);
  });

  it('prefers absolute localPath when present', async () => {
    const abs = path.join(tmp, 'StripperScrapper', 'aula.bin');
    const r = await resolveArtifactSourcePath(
      { inboxDir: '/nonexistent' },
      { localPath: abs }
    );
    assert.equal(r.localPath, abs);
  });
});
