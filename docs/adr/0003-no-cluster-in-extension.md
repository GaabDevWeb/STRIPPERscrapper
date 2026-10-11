# ADR-0003: Sem modo cluster multi-browser na extensão

| Campo | Valor |
|-------|-------|
| Data | 2026-08-09 |
| Status | proposed |
| Deciders | MegaBrain |

## Contexto

O orquestrador actual (`main.js`) suporta cluster: 1 browser mapeia tasks → shard → N browsers Puppeteer com `temp_downloads/worker-<id>`.

Uma Browser Extension partilha **um** perfil/sessão do utilizador. Abrir N browsers automatizados derrota o propósito da migração (CAPTCHA/sessão humana).

## Decisão

- Na extensão: **fila sequencial** (ou concorrência limitada de downloads via `chrome.downloads`, sem N sessões).
- Cluster Puppeteer **não** é portado para a extensão.
- Paralelismo opcional futuro: processamento no core (Markdown/validação) após downloads, não N browsers.

## Consequências

- Flags `--workers` / sharding deixam de aplicar ao path extensão.
- Throughput limitado a um browser — aceitável v1 face a CAPTCHA.
- Código `shard.mjs` permanece para CLI legado.

## Referências

- `main.js`, `src/utils/shard.mjs`
- PRD RF-012
