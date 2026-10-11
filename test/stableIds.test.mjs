import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeUrlForId,
  extractGoogleDriveFileId,
  extractBuddyPressDocumentId,
  stableTranscriptItemId,
  stableDocumentItemId,
} from '../src/utils/stableIds.mjs';
import * as fromManifest from '../src/utils/downloadManifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesPath = path.join(
  __dirname,
  '..',
  'memory',
  'browser-extension-migration',
  'stable-id-fixtures.json'
);

describe('stableIds golden vectors', () => {
  it('matches fixtures 100%', async () => {
    const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));
    assert.ok(Array.isArray(fixtures.vectors) && fixtures.vectors.length > 0);
    for (const v of fixtures.vectors) {
      assert.equal(normalizeUrlForId(v.url), v.normalizeUrlForId, v.name);
      assert.equal(extractGoogleDriveFileId(v.url), v.extractGoogleDriveFileId, v.name);
      assert.equal(extractBuddyPressDocumentId(v.url), v.extractBuddyPressDocumentId, v.name);
      assert.equal(stableTranscriptItemId(v.url), v.stableTranscriptItemId, v.name);
      assert.equal(stableDocumentItemId(v.url), v.stableDocumentItemId, v.name);
    }
  });

  it('downloadManifest re-exports identical IDs', async () => {
    const fixtures = JSON.parse(await readFile(fixturesPath, 'utf8'));
    for (const v of fixtures.vectors) {
      assert.equal(fromManifest.stableTranscriptItemId(v.url), stableTranscriptItemId(v.url));
      assert.equal(fromManifest.stableDocumentItemId(v.url), stableDocumentItemId(v.url));
      assert.equal(fromManifest.extractGoogleDriveFileId(v.url), extractGoogleDriveFileId(v.url));
      assert.equal(
        fromManifest.extractBuddyPressDocumentId(v.url),
        extractBuddyPressDocumentId(v.url)
      );
    }
  });
});
