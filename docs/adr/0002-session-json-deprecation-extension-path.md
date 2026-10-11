# ADR-0002: `session.json` no path da Browser Extension

| Campo | Valor |
|-------|-------|
| Data | 2026-08-09 |
| Status | proposed |
| Deciders | MegaBrain (migração Browser Extension) |

## Contexto

O scraper actual persiste cookies + `localStorage` em `session.json` (raiz do repo), escrito atomicamente com lock, usado por `ensureAuthenticated` / `applySession` / `saveSession` em `src/utils/infnetShared.mjs`.

Com CAPTCHA, o login automatizado e a reutilização de `session.json` deixam de ser a fonte primária fiável. A extensão corre **dentro** do browser onde o utilizador já autenticou — a sessão é o cookie jar do próprio browser.

**Regra do brief:** não remover `session.json` silenciosamente; decidir e documentar.

## Decisão

No **path Browser Extension + Core Bridge**:

1. **Fonte primária da sessão autenticada** = browser do utilizador (cookies da extensão / contexto do site).
2. **`session.json` deixa de ser necessário** para discovery/download neste path.
3. O core **não** recebe nem persiste cookies/tokens da extensão.
4. Estados de autenticação (`NOT_AUTHENTICATED` … `SESSION_EXPIRED`) vivem na extensão; o core só reage a erros tipados (`SESSION_EXPIRED`, HTML de login na validação).
5. O path **legado Puppeteer/CLI** pode continuar a usar `session.json` até ser removido noutro ADR; ficheiros e código de sessão permanecem no repo, mas a UI/docs da extensão **não** pedem `FACULDADE_USER`/`FACULDADE_PASS` como fluxo principal.

**Substitui `session.json`:** sessão do navegador + detecção de auth na extensão + sinalização tipada ao core.

## Alternativas consideradas

### Alternativa A — Continuar a exportar cookies para `session.json`

- Prós: reutiliza `ensureAuthenticated` quase intacto.
- Contras: risco de vazamento; duplica sessão; frágil com CAPTCHA; contradiz “não vazar cookies”.

### Alternativa B — Extensão como única sessão (escolhida)

- Prós: alinhado ao CAPTCHA manual; sem persistência de cookies no disco do projecto.
- Contras: core não pode “reabrir” sessão sozinho; utilizador deve reautenticar no browser.

## Consequências

### Positivas

- Menos superfície de segredos no disco.
- Fluxo humano natural para CAPTCHA.
- Logs do core sem cookies.

### Negativas / trade-offs

- Reinício do browser/extensão pode exigir novo login se a sessão WordPress expirar.
- CLI legado e path extensão coexistem temporariamente — documentar claramente no README.

## Referências

- `src/utils/infnetShared.mjs` (`loadSession`, `saveSession`, `ensureAuthenticated`)
- PRD RF-002, RF-015
