# Contributing Guide — StripperScrapper

## Style & Git Workflow

### Código

| Área | Convenção |
|------|-----------|
| Runtime | Node.js ESM (`"type": "module"`); extensão MV3 JS |
| Formatação | Seguir estilo existente (sem ponto-e-vírgula inconsistente com ficheiros tocados) |
| Naming | camelCase funções; ficheiros scrapers `*Scraper.js`; utils `*.mjs` |
| Comentários | Só quando clarificam invariantes (manifest, IDs, segurança) |
| Segredos | Nunca commitir `.env`, `session.json`, `.bridge-token`, cookies |
| Logs | Sem passwords, cookies, tokens, localStorage |

### Estrutura esperada (pós-migração)

```
extension/          # Browser Adapter (MV3)
src/
  scrapers/         # Core discovery/process (refactors)
  utils/            # manifest, integrity, retry (preferir reutilizar)
  bridge/           # HTTP local (novo)
main.js             # CLI legado + eventual entry core
docs/               # PRD, ADR, arquitectura
```

### Princípios da migração

1. Extensão = adapter; core = processamento/manifest.
2. Não duplicar `downloadManifest` / `validateBinaryFile` / `toMarkdown`.
3. Não automatizar CAPTCHA.
4. IDs estáveis idênticos aos actuais.
5. Alterações de schema de saída exigem ADR + actualização PRD.

### Git

**Branches:**

```
feature/browser-extension-migration
fix/<descricao>
docs/<descricao>
```

**Commits (Conventional Commits):**

```
feat: …
fix: …
docs: …
refactor: …
test: …
chore: …
```

**Pull Requests:**

- [ ] Testes/checklist do PRD passam no âmbito tocado
- [ ] Sem segredos no diff
- [ ] PRD/ADR actualizados se comportamento mudou
- [ ] Manifest/idempotência cobertos se tocados

### Comandos úteis (actual + futuros)

```bash
npm install
npm start -- --lessons          # CLI legado
# futuros (após implementação):
# npm run core                  # bridge HTTP
# carregar extension/ no Chrome (Developer mode)
```

### Testes

O repo **não** tem suite automatizada hoje. Para a migração:

1. Testes unitários novos para IDs estáveis, validação HTML, manifest verifyArtifact (prioridade).
2. Checklist E2E manual com sessão real (CAPTCHA) — ver PRD / plano de testes.
3. Nunca gravar fixtures com cookies reais.

### Documentação

- SSOT legado: `ARQUITETURA_E_FLUXOS.md`
- Pacote produto: `docs/prd/`, `docs/ARCHITECTURE.md`, `docs/API_SPEC.md`, `docs/DATA-MODEL.md`, `docs/adr/`
- Histórico agente: `.agent_history.md`

## Segurança

- Bridge só `127.0.0.1`.
- Token bridge ≠ credenciais Infnet.
- Extensão não persiste password.
- Reviews devem procurar vazamento em logs e payloads de erro.
