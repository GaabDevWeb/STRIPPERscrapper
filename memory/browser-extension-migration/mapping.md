# Mapping — scraper Puppeteer → extensão MV3

| Origem | Destino extensão | Destino core (outro agente) |
|--------|------------------|-----------------------------|
| `ensureAuthenticated` / login | `content/infnetAuth.js` + `lib/authState.js` | — (sem session.json) |
| `extractLessonItemsFromPage` | `content/lessonDiscovery.js` | ingest `POST /v1/discovery/lessons` |
| `stableTranscriptItemId` | `lib/stableIds.js` | `downloadManifest.mjs` (fonte) |
| `collectDocumentTasksFromSite` BFS | `background.js` + `content/documentDiscovery.js` | `POST /v1/discovery/documents` |
| `stableDocumentItemId` | `lib/stableIds.js` | `downloadManifest.mjs` |
| Drive CDP download | `chrome.downloads` + `driveDownload.js` | artifact ingest |
| `downloadBinaryWithSession` | `chrome.downloads.download` (cookies browser) | validate + manifest |
| dashboard TUI | `popup/*` | `GET /v1/jobs/:id`, manifest summary |

Selectors aulas: `.infnetci-recording-item`, `h3`, `.transcription-link`, `button.infnetci-accordion-button`.  
Selectors docs: `.media-folder_items.ac-folder-list` / `ac-document-list`, `a.media-folder_name`, `li.download_file a`.
