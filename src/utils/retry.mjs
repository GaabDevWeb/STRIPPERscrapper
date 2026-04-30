function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms, ratio = 0.25) {
  const base = Math.max(0, Number(ms) || 0);
  const r = Math.max(0, Number(ratio) || 0);
  const delta = base * r;
  return Math.max(0, Math.round(base + (Math.random() * 2 - 1) * delta));
}

/**
 * @typedef {object} RetryContext
 * @property {number} attempt — 1..N
 * @property {number} retries — N
 * @property {unknown} error
 * @property {number} delayMs
 */

/**
 * Executa `fn` com retries e backoff simples.
 *
 * - `retries` conta o total de tentativas (inclui a 1ª).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries=3]
 * @param {number[]} [opts.backoffMs=[400,1200,2500]]
 * @param {(err: unknown) => boolean} [opts.isRetryable]
 * @param {(ctx: RetryContext) => void | Promise<void>} [opts.onRetry]
 * @returns {Promise<T>}
 */
export async function withRetries(fn, opts = {}) {
  const retries = Math.max(1, Number(opts.retries ?? 3) || 3);
  const backoffMs = Array.isArray(opts.backoffMs) && opts.backoffMs.length
    ? opts.backoffMs.map((n) => Math.max(0, Number(n) || 0))
    : [400, 1200, 2500];
  const isRetryable = typeof opts.isRetryable === 'function' ? opts.isRetryable : () => true;
  const onRetry = typeof opts.onRetry === 'function' ? opts.onRetry : null;

  /** @type {unknown} */
  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < retries && !!isRetryable(err);
      if (!canRetry) throw err;

      const idx = Math.min(attempt - 1, backoffMs.length - 1);
      const delayMs = jitter(backoffMs[idx], 0.25);
      if (onRetry) {
        await onRetry({ attempt, retries, error: err, delayMs });
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  // invariável: nunca deve cair aqui sem lançar
  throw /** @type {any} */ (lastErr) || new Error('Falha após retries');
}

