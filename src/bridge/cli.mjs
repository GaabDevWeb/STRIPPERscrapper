#!/usr/bin/env node
/**
 * Entrypoint `npm run core` — Core Bridge HTTP em 127.0.0.1.
 * Não usa session.json; token ≠ credenciais Infnet.
 */
import 'dotenv/config';
import { createBridgeServer } from './server.mjs';
import { loadBridgeConfig } from './config.mjs';

async function main() {
  const cfg = loadBridgeConfig();
  const bridge = await createBridgeServer(cfg);
  const { host, port } = await bridge.listen();

  console.log(`[bridge] listening http://${host}:${port}`);
  console.log(`[bridge] token file: ${cfg.tokenPath}`);
  console.log(`[bridge] inbox: ${cfg.inboxDir}`);
  console.log(`[bridge] downloads: ${cfg.downloadsDir}`);
  console.log('[bridge] GET /health (no auth) | remaining routes require X-Stripper-Token');
  // Nunca imprimir o token em logs (RF-013). Operador: `cat .bridge-token` / colar na UI.
  console.log('[bridge] token: (não logado — ler ficheiro .bridge-token para a extensão)');

  const shutdown = async (signal) => {
    console.log(`[bridge] ${signal} — shutting down`);
    try {
      await bridge.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[bridge] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
