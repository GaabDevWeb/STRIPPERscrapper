/**
 * Prefixos de log para workers (cluster).
 */
import chalk from 'chalk';

/**
 * @param {number | string} workerId
 * @param {'AULAS' | 'DOCS' | 'MAPA' | 'ORQ'} section
 */
export function workerLogTag(workerId, section) {
  return chalk.bold.cyan(`[WORKER-${workerId}][${section}]`);
}

/**
 * @param {string | undefined} tag
 */
export function makeTaggedLoggers(tag) {
  if (!tag) {
    return {
      log: console.log.bind(console),
      error: console.error.bind(console),
      warn: console.warn.bind(console),
    };
  }
  return {
    log: (...args) => console.log(tag, ...args),
    error: (...args) => console.error(tag, ...args),
    warn: (...args) => console.warn(tag, ...args),
  };
}
