# ADR-0001: Bridge extensão ↔ core via HTTP local (127.0.0.1)

| Campo | Valor |
|-------|-------|
| Data | 2026-08-09 |
| Status | proposed |
| Deciders | MegaBrain (migração Browser Extension) |

## Contexto

A extensão precisa enviar tarefas, metadados e artefactos (ou referências a ficheiros descarregados) ao Scraper Core Node existente (`downloadManifest`, `integrity`, `toMarkdown`, scrapers refactored). Alternativas avaliadas no brief:

- **A)** Extensão chama serviço local HTTP
- **B)** Native Messaging
- **C)** Extensão só baixa; core observa pasta
- **D)** Outra

Critérios: simplicidade v1, segurança, manutenção, downloads grandes, não exposição desnecessária, core reutilizável.

## Decisão

**v1 adopta A — HTTP local bind exclusivo a `127.0.0.1`**, com token de sessão local de curta duração gerado pelo core na arranque (não credenciais Infnet).

A extensão:

1. Faz discovery no contexto autenticado do browser.
2. Inicia downloads via APIs da extensão (`chrome.downloads` / fetch com cookies do browser).
3. Notifica o core com metadados da task + caminho/blob do artefacto.
4. O core valida, move, gera Markdown, actualiza manifest/DLQ.

Native Messaging fica como evolução opcional (ADR futuro) se o HTTP local revelar fricção de segurança ou DX.

## Alternativas consideradas

### Alternativa A — HTTP local (escolhida)

- Prós: debug fácil; reutiliza Node; contrato JSON claro; core permanece entrypoint CLI/`npm run core`.
- Contras: processo Node tem de estar a correr; endpoint local (mitigado com bind loopback + token).

### Alternativa B — Native Messaging

- Prós: canal oficial Chrome↔host; sem porta TCP.
- Contras: setup de host manifest por SO; DX mais pesada; iterações mais lentas na v1.

### Alternativa C — Watch de pasta

- Prós: mínimo transporte.
- Contras: acoplamento frágil metadados↔ficheiros; difícil progresso/cancel/DLQ/idempotência fina; risco de processar downloads irrelevantes.

## Consequências

### Positivas

- Core permanece dono do manifest e processamento.
- Extensão fica fina (adapter).
- Contrato testável sem browser (mocks HTTP).

### Negativas / trade-offs

- Dois processos (browser + core).
- Downloads grandes: preferir path de ficheiro já descarregado pelo browser em vez de multipart gigante quando possível.

## Referências

- PRD: `docs/prd/2026-08-09-browser-extension-migration.md`
- Arquitectura: `docs/ARCHITECTURE.md`
