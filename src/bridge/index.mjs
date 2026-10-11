/**
 * API pública do Core Bridge (importável por testes / tooling).
 */
export { loadBridgeConfig, resolveInboxDir } from './config.mjs';
export { loadOrCreateBridgeToken, tokensMatch } from './token.mjs';
export { createBridgeState } from './state.mjs';
export {
  processArtifact,
  classifyHtmlArtifact,
  sniffHtmlSession,
  resolveArtifactSourcePath,
} from './ingest.mjs';
export {
  startJob,
  getJobView,
  cancelJob,
  applyArtifactToRuns,
  countAgainstManifest,
  manifestSummary,
  withRetries,
} from './jobs.mjs';
export { createBridgeServer } from './server.mjs';
