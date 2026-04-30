# Validação de seletores (browser / MCP)

**Data:** 2026-04-28

## Login

| Item | Resultado |
|------|-----------|
| URL direta | `https://infnet.online/wp-login.php` — HTTP 200, formulário de acesso |
| Campos visíveis | Textbox **“Endereço de E-mail”**, textbox **“Senha”**, botão **“Entrar”** |
| `#user_login` / `#user_pass` | Não confirmados via snapshot acessível; domínio é WordPress — **fallback no código**: `#user_login`/`#user_pass`, `input[name="log"]`/`input[name="pwd"]`, `input[type="email"]` / `input[type="password"]` |

## Página das aulas (rota protegida)

| Item | Resultado |
|------|-----------|
| URL alvo | `https://infnet.online/grupos/fundamentos-do-processamento-de-dados-26e1-26e2-93422564/infnet-ci-zoom-mettings/` |
| Sem sessão | Redirect para `wp-login.php` com query `redirect_to=...` e `action=bpnoaccess` — **login necessário antes da raspagem** |

## Lista de aulas e transcrição

| Item | Resultado |
|------|-----------|
| `.infnetci-recording-item` | Planejado conforme `agent.md`; **só verificável após login** no ambiente real |
| `.transcription-link` | Idem |

## Google Drive (download)

| Item | Resultado |
|------|-----------|
| Botão de download | UI do Drive varia (viewer vs preview); **código tenta** `aria-label="Fazer download"` e seletores alternativos |
| Risco | Iframes, consentimento ou bloqueio de automação podem exigir ajuste manual ou seletor extra |

## Conclusão

Fluxo **login → redirect_to → aulas** está coerente. Implementação usa seletores primários do `agent.md` com fallbacks e tratamento de erro por item.

## Instalação (npm)

- Se o disco estiver sem espaço para o Chromium embutido: `PUPPETEER_SKIP_DOWNLOAD=true npm install` e defina `PUPPETEER_EXECUTABLE_PATH` apontando para o Chrome instalado (ver `.env.example`).
