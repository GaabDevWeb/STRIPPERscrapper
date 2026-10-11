# Data Model — StripperScrapper (Extension + Core)

| Campo | Valor |
|-------|-------|
| Persistência | JSON em disco (sem SGBD) |
| Última actualização | 2026-08-09 |

## Diagrama (entidades lógicas)

```
AuthState (extensão, efémero)
Run 1──N Task
Task 1──0..1 ManifestEntry
ManifestEntry 0..1── ArtifactFile
ManifestEntry 0..1── MarkdownFile
```

## Entidades

### AuthState (extensão)

| Campo | Tipo | Null | Descrição |
|-------|------|------|-----------|
| status | enum | NO | `NOT_AUTHENTICATED` \| `AUTHENTICATING` \| `AUTHENTICATED` \| `SESSION_EXPIRED` \| `ERROR` |
| checkedAt | ISO8601 | YES | última verificação |
| detail | string | YES | mensagem segura (sem cookies) |

**Regras:** nunca serializar cookies/tokens Infnet para o core.

---

### DiscoveryTask (transporte)

Alinha-se aos tasks actuais do código.

#### LessonTask

| Campo | Tipo | Origem actual |
|-------|------|---------------|
| id | string | `transcriptItemId` / `stableTranscriptItemId` |
| type | `"lesson"` | novo wrapper |
| domIndex | number | `domIndex` |
| title | string | `title` |
| source_url / download_url | string | `href` |
| course | string | `courseName` |
| metadata.accordionTitle | string | `accordionTitle` |

#### DocumentTask

| Campo | Tipo | Origem actual |
|-------|------|---------------|
| id | string | `documentItemId` / `stableDocumentItemId` |
| type | `"document"` | wrapper |
| path | string | `relParts` joined |
| filename | string | de `title` + ext |
| extension | string | `ext` |
| source_url | string | `downloadUrl` |
| metadata.relParts | string[] | `relParts` |
| metadata.listUrl | string | `listUrl` |

---

### ManifestDoc (`downloads/manifest.json`)

**Preservar schema actual** (`MANIFEST_VERSION = 1`).

| Campo | Tipo | Descrição |
|-------|------|-----------|
| version | number | 1 |
| updatedAt | string | ISO8601 |
| entries | map id→ManifestEntry | |

### ManifestEntry

| Campo | Tipo | Descrição |
|-------|------|-----------|
| kind | `transcript` \| `document` | |
| status | `completed` \| `error` | |
| sourceUrl | string | |
| artifactRelPath | string? | relativo a manifestRoot (POSIX) |
| markdownRelPath | string? | aulas |
| completedAt / errorAt | string? | |
| errorKind | string? | |
| reason | string? | |
| attempts | number? | |
| lastErrorAt / lastError | string? | sanitizado |

**Regras (inalteradas):**

- `isItemCompleted(..., { verifyArtifact: true })` — se ficheiro ausente, não conta completed.
- Escrita atómica + lock `manifest.json.queue.lock`.
- Após max attempts → `status: error` (DLQ lógica).

---

### Markdown front-matter (aulas)

| Campo | Obrigatório | Notas |
|-------|-------------|-------|
| title | sim | |
| source_url | sim | |
| course | sim | |
| transcript_file | sim | nome/path relativo do artefacto |
| downloaded_at | sim | ISO8601 |

Compatibilidade com `toMarkdown` em `lessonScraper.js`.

---

### Run (core, runtime)

| Campo | Tipo | Descrição |
|-------|------|-----------|
| runId | string | id do job |
| scope | enum | lessons/docs/all |
| mode | enum | discover_only / discover_and_download |
| ignoreManifest | bool | |
| failFast | bool | |
| status | enum | running/paused_auth/cancelled/completed/failed |
| counters | object | completed/skipped/failed/dlq/pending |

Não precisa de persistência durável na v1 (opcional log).

---

### session.json (legado)

| Campo | Tipo | Path |
|-------|------|------|
| cookies | array | Puppeteer cookie objects |
| localStorage | object | key→value |

**Path extensão:** não usado (ADR-0002). Path CLI legado: opcional até remoção futura.

## Relações

| De | Para | Cardinalidade | Notas |
|----|------|---------------|-------|
| DiscoveryTask.id | ManifestEntry key | 1:0..1 | mesmo ID estável |
| ManifestEntry | ficheiro em `downloads/` | 0..1 | verifyArtifact |
| Lesson completed | `.md` adjacente | 0..1 | markdownRelPath |

## Índices / lookups

- Lookup O(1) por id em `entries`.
- Sem BD: ficheiro JSON único com lock.

## Migrações

- **Não** migrar schema do manifest na v1.
- IDs estáveis devem continuar a bater com artefactos já descarregados (refresh de semestre sem redownload).
