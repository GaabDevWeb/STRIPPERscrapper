# Plano SSOT — browser-extension-migration

Aceite 2026-08-09 após `/planejar`. IR: `plan.ir.yaml`.

| ID | Descrição | Estado |
|----|-----------|--------|
| 1 | Mapping SSOT | **done** (`mapping.md`) |
| 2 | Contrato bridge-v1 | **done** (`docs/contracts/bridge-v1.yaml`) |
| 3 | Scaffold extension + bridge | **done** (extensão); bridge quase completo |
| 4 | Auth state machine | **done** (`extension/lib/authState.js`) |
| 5 | Stable IDs + goldens | **done** (core + extensão 12/12) |
| 6–7 | Discovery lessons/docs | **done** (content scripts) |
| 8 | Bridge HTTP completo | **done** (`src/bridge/`, `npm run core`) |
| 9 | Spike chrome.downloads | **done** GO (`spike-drive-downloads.md`) |
| 10–11 | Download adapters | **done** (background + driveDownload) |
| 12–13 | Ingest + manifest | **done** (+ inbox resolve) |
| 14 | Testes | **done** (`npm test` 14/14) |
| 15 | UI popup | **done** (`extension/popup/`) |
| 16 | Security gate | **done** PASS (`telemetry/evidence/security-review.json`) |
| 17 | Docs operacionais | **done** (`docs/EXTENSION_OPERATOR.md` + README) |
| PO | Aceite produto | **OK** (retries/DLQ corrigidos) |

Ordem mandatória e briefings: entrega do planner nesta sessão.
