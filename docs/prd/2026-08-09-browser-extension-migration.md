# PRD — Migração Browser Extension (StripperScrapper)

| Campo | Valor |
|-------|-------|
| Data | 2026-08-09 |
| Autor | MegaBrain / utilizador |
| Status | review |
| Versão | 1.0 |
| Feature slug | `browser-extension-migration` |

## Contexto

**Proveniência:** requisitos fechados pelo utilizador via `/MegaBrain` (2026-08-09). Arquitectura actual documentada em `ARQUITETURA_E_FLUXOS.md` (SSOT do scraper Puppeteer).

O scraper CLI (Node.js + Puppeteer) funciona bem, mas o portal Infnet passou a exigir CAPTCHA no login. Automação de login/`session.json` deixa de ser fiável. A migração **não** reescreve o pipeline: move apenas a **camada de acesso ao site autenticado** para uma Browser Extension; o utilizador autentica-se e resolve CAPTCHA manualmente.

**Problema:** CAPTCHA bloqueia `ensureAuthenticated` + login automatizado.

**Oportunidade:** sessão do browser real do utilizador + core Node reutilizável (manifest, integridade, Markdown, DLQ).

## Objectivos

Quando pronto:

1. Utilizador autentica manualmente (CAPTCHA incluído); extensão detecta sessão.
2. Discovery de aulas e documentos produz tarefas com IDs estáveis existentes (`transcript:…`, `document:…`).
3. Downloads autenticados funcionam; validação/Markdown/manifest/retries/DLQ permanecem no core.
4. Saída em `downloads/` permanece equivalente (secções, documents, manifest, front-matter).
5. Sem bypass de CAPTCHA; sem credenciais em texto na extensão; sem cookies/tokens em logs.

**Métricas de sucesso:** checklist de critérios de aceite do brief (auth, discovery, download, validação, Markdown, manifest, idempotência, retries, DLQ, sessão expirada, logs seguros).

## Personas / Utilizadores

| Persona | Necessidade |
|---------|-------------|
| Estudante Infnet (operador local) | Actualizar base de conhecimento do semestre com login manual + CAPTCHA |
| Mantenedor do repo | Preservar contratos do core; evitar duplicação extensão↔core |

## Requisitos funcionais

| ID | Descrição | Prioridade | Critério de aceite |
|----|-----------|------------|-------------------|
| RF-001 | Extensão com estados `NOT_AUTHENTICATED` \| `AUTHENTICATING` \| `AUTHENTICATED` \| `SESSION_EXPIRED` \| `ERROR` | Must | UI e API interna reflectem estado; transição após login manual |
| RF-002 | Login/CAPTCHA apenas pelo utilizador no site | Must | Nenhuma automação de CAPTCHA/tokens; sem armazenar `FACULDADE_PASS` na extensão |
| RF-003 | Discovery de aulas (DOM equivalente a `extractLessonItemsFromPage`) | Must | Lista de tasks com `transcriptItemId` = `stableTranscriptItemId(href)` |
| RF-004 | Discovery de documentos (BFS + lazy + maxDepth + extensões) | Must | Tasks com `documentItemId` = `stableDocumentItemId(url)` |
| RF-005 | Separação DISCOVER vs DOWNLOAD/PROCESS | Must | Modo “apenas descobrir” e “descobrir + baixar” na UI |
| RF-006 | Bridge extensão → core local | Must | Core recebe metadados/artefactos; processa com módulos existentes |
| RF-007 | Manifest preservado (`downloads/manifest.json`) | Must | SKIP se artefacto válido; pending se completed sem ficheiro; retry; DLQ |
| RF-008 | Retries ≤ 3 com backoff + jitter (`withRetries`) | Must | Erros temporários retry; sessão expirada não entra em loop infinito |
| RF-009 | Validação (`validateBinaryFile` + regras equivalentes) | Must | HTML/login não marca completed |
| RF-010 | Markdown + front-matter (`title`, `source_url`, `course`, `transcript_file`, `downloaded_at`) | Must | Compatível com `toMarkdown` actual |
| RF-011 | UI operacional mínima | Must | Status, discovery, progresso, skip/fail/DLQ, cancelar, reauth |
| RF-012 | Modos: aulas / docs / tudo; fail-fast; continuar/ignorar manifest | Must | Mapeados na UI; cluster Puppeteer **não** forçado na extensão |
| RF-013 | Observabilidade sem vazamento de segredos | Must | Logs com tarefa/tipo/resultado; zero cookies/tokens/senhas |
| RF-014 | Suporte a novo semestre (disciplina/URL seleccionável) | Should | Discovery com `CLASSES_URL`/`DOCUMENTS_URL` configuráveis; materiais antigos intactos |
| RF-015 | Decisão explícita sobre `session.json` | Must | Documentado: deprecado no path extensão; bridge não o exige |

## Requisitos não-funcionais

| ID | Descrição | Critério |
|----|-----------|----------|
| RNF-001 | Segurança local | Bridge só em `127.0.0.1`; sem credenciais em disco pela extensão |
| RNF-002 | Reutilização | Core (`downloadManifest`, `integrity`, `retry`, `toMarkdown`, path helpers) não duplicado na extensão |
| RNF-003 | Simplicidade v1 | Sem orquestração distribuída; fila sequencial na extensão |
| RNF-004 | Compatibilidade de saída | Layout `downloads/<Secção>/`, `downloads/documents/`, `manifest.json` |
| RNF-005 | Testabilidade | Suite/checklist documentada (auth, discovery, idempotência, DLQ, cancel) |

## Fora de escopo

- Bypass/automatização de CAPTCHA ou anti-bot
- Cluster multi-browser Puppeteer dentro da extensão
- Reescrita completa do scraper
- Servidor remoto / cloud
- Alteração do schema de artefactos/Markdown sem necessidade
- Armazenar credenciais Infnet na extensão

## Dependências e riscos

| Item | Tipo | Mitigação |
|------|------|-----------|
| CAPTCHA / MFA | dependência humana | Fluxo manual obrigatório; estados de sessão explícitos |
| Seletores Infnet/Drive/BuddyPress frágeis | risco | Reutilizar seletores actuais; `VALIDACAO_SELETORES.md` |
| Google Drive download via extensão (sem CDP) | risco | Usar `chrome.downloads` + espera de ficheiro estável no core; spike se API insuficiente |
| Transport extensão↔core | decisão | ADR-0001: HTTP local `127.0.0.1` v1 |
| Path legado Puppeteer | dívida | Manter CLI legado opcional até estabilizar extensão; documentar |

## Glossário

| Termo | Definição |
|-------|-----------|
| Browser Adapter | Extensão: sessão, discovery, navegação, downloads, UI |
| Scraper Core | Node: manifest, validação, retries, Markdown, organização |
| Task | Unidade discoverida (`transcriptItemId` / `documentItemId`) |
| DLQ | Entrada `status: error` no manifest após retries esgotados |
| Bridge | Transporte local extensão → core |

## Referências

- SSOT actual: `ARQUITETURA_E_FLUXOS.md`
- ADR: `docs/adr/0001-extension-local-http-bridge.md`
- API: `docs/API_SPEC.md`
- Arquitectura: `docs/ARCHITECTURE.md`
- Data model: `docs/DATA-MODEL.md`
