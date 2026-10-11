# API Specification — Core Bridge (local)

| Campo | Valor |
|-------|-------|
| Versão | v1 |
| Base URL | `http://127.0.0.1:<PORT>` (PORT via env, default proposto `8787`) |
| Última actualização | 2026-08-09 |
| Autenticação | Header `X-Stripper-Token: <token>` emitido pelo core no arranque (ficheiro local ou stdout); **não** é credencial Infnet |

## Convenções

- `Content-Type: application/json` salvo upload binário (`multipart/form-data` ou path local).
- Datas: ISO 8601 UTC.
- IDs de artefactos: **preservar** formatos actuais:
  - `transcript:gdrv:<id>` / `transcript:url:<sha48>`
  - `document:bp:<id>` / `document:url:<sha48>`
- Erros tipados em `errorKind`: `network` \| `timeout` \| `http` \| `integrity` \| `html` \| `session_expired` \| `cancelled` \| `unknown`
- **Proibido** nos logs/responses de debug: cookies, tokens Infnet, passwords, localStorage.

## Autenticação do bridge

O core gera um token aleatório ao iniciar e escreve-o em ficheiro local ignorado pelo git (ex. `.bridge-token`) **ou** imprime uma vez. A extensão lê via Native Messaging futuro **ou**, na v1, o utilizador cola/configura o token na UI da extensão (mínimo operacional). Bind apenas `127.0.0.1`.

## Endpoints

### GET /health

**Descrição:** liveness do core.

**Autenticação:** optional

**Response 200:**

```json
{
  "ok": true,
  "version": 1,
  "manifestPath": "…/downloads/manifest.json"
}
```

---

### GET /v1/auth/bridge

**Descrição:** confirma token válido (extensão).

**Autenticação:** required

**Response 200:** `{ "ok": true }`  
**Response 401:** `{ "ok": false, "error": "unauthorized" }`

---

### POST /v1/discovery/lessons

**Descrição:** regista resultado de discovery de aulas (extensão → core). Não baixa.

**Autenticação:** required

**Request:**

```json
{
  "classesUrl": "https://infnet.online/grupos/…/infnet-ci-zoom-mettings/",
  "courseName": "Disciplina",
  "discoveredAt": "2026-08-09T12:00:00.000Z",
  "tasks": [
    {
      "type": "lesson",
      "domIndex": 0,
      "title": "Aula 1",
      "source_url": "https://drive.google.com/…",
      "download_url": "https://drive.google.com/…",
      "id": "transcript:gdrv:FILEID",
      "course": "Disciplina",
      "metadata": { "accordionTitle": "Secção" }
    }
  ]
}
```

**Response 200:**

```json
{
  "ok": true,
  "total": 100,
  "pending": 20,
  "completed": 80,
  "error": 0
}
```

Notas: core cruza com manifest (`isItemCompleted` + `verifyArtifact`).

---

### POST /v1/discovery/documents

**Descrição:** regista discovery de documentos.

**Request (conceitual):**

```json
{
  "documentsUrl": "https://infnet.online/grupos/…/documents/",
  "discoveredAt": "2026-08-09T12:00:00.000Z",
  "tasks": [
    {
      "type": "document",
      "id": "document:bp:123",
      "path": "pasta/sub",
      "filename": "slides.pptx",
      "extension": "pptx",
      "source_url": "https://…",
      "metadata": { "relParts": ["pasta", "sub"] }
    }
  ]
}
```

**Response 200:** igual estrutura de contagens (`total` / `pending` / `completed` / `error`).

---

### POST /v1/jobs/start

**Descrição:** inicia processamento/download das tasks pending (core coordena política; extensão executa downloads sob pedido).

**Request:**

```json
{
  "scope": "lessons" | "docs" | "all",
  "mode": "discover_only" | "discover_and_download",
  "ignoreManifest": false,
  "failFast": false,
  "limit": null
}
```

**Response 200:** `{ "ok": true, "runId": "…", "queued": 20 }`

---

### GET /v1/jobs/:runId

**Descrição:** progresso do run.

**Response 200:**

```json
{
  "runId": "…",
  "status": "running" | "paused_auth" | "cancelled" | "completed" | "failed",
  "progress": {
    "completed": 5,
    "skipped": 80,
    "failed": 1,
    "dlq": 1,
    "pending": 13
  }
}
```

---

### POST /v1/jobs/:runId/cancel

**Descrição:** cancela run em curso.

**Response 200:** `{ "ok": true }`

---

### POST /v1/artifacts/:taskId/artifact

**Descrição:** notifica artefacto pronto para ingestão no core.

**Autenticação:** required

**Request (JSON path preferido v1):**

```json
{
  "id": "transcript:gdrv:FILEID",
  "type": "lesson",
  "localPath": "/home/…/Downloads/file.vtt",
  "source_url": "https://…",
  "course": "Disciplina",
  "title": "Aula 1",
  "metadata": { "accordionTitle": "Secção" },
  "attempt": 1
}
```

Alternativa: `multipart` com ficheiro se path inacessível ao core.

**Response 200:**

```json
{
  "ok": true,
  "result": "completed" | "skipped" | "error",
  "artifactRelPath": "Secção/aula-1.vtt",
  "markdownRelPath": "Secção/aula-1.md",
  "errorKind": null
}
```

**Response 409 / tipado sessão:**

```json
{
  "ok": false,
  "errorKind": "session_expired",
  "reason": "artifact looks like HTML login page"
}
```

Neste caso a extensão muda estado para `SESSION_EXPIRED` e **não** esgota retries como falha de rede.

---

### GET /v1/manifest/summary

**Descrição:** contagens para UI.

**Response 200:**

```json
{
  "version": 1,
  "updatedAt": "…",
  "counts": { "completed": 80, "error": 5, "pendingUnknown": 0 }
}
```

---

### POST /v1/events

**Descrição:** eventos de observabilidade (sem PII/sessão).

**Request:**

```json
{
  "runId": "…",
  "taskId": "transcript:gdrv:…",
  "type": "lesson",
  "phase": "download_start" | "download_end" | "validate" | "markdown" | "skip" | "retry" | "dlq",
  "attempt": 2,
  "startedAt": "…",
  "endedAt": "…",
  "durationMs": 1200,
  "result": "ok" | "error" | "skipped",
  "errorKind": null,
  "reason": null
}
```

## Códigos de erro HTTP

| Código | Significado |
|--------|-------------|
| 400 | payload inválido |
| 401 | token bridge inválido |
| 404 | run/task desconhecido |
| 409 | conflito (ex. sessão / estado) |
| 413 | ficheiro acima de limite |
| 500 | erro interno core |

## Relação com RF

| RF | Endpoints |
|----|-----------|
| RF-003/004 | `/v1/discovery/*` |
| RF-005/012 | `/v1/jobs/start` modes |
| RF-006 | todos |
| RF-007/008/009 | `/v1/tasks/:id/artifact` + lógica core |
| RF-011 | `/v1/jobs/:id`, `/v1/manifest/summary` |
