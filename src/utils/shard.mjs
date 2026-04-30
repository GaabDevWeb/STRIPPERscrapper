/**
 * Partição estável de tarefas para workers (sharding).
 * @template T
 * @param {T[]} items
 * @param {number} workerCount — >= 1
 * @param {number} workerIndex — 0-based
 * @returns {T[]}
 */
export function partitionTasksForWorker(items, workerCount, workerIndex) {
  if (!items.length) return [];
  const w = Math.max(1, Math.floor(workerCount) || 1);
  const idx = Math.min(Math.max(0, workerIndex), w - 1);
  const n = items.length;
  const base = Math.floor(n / w);
  const rem = n % w;
  const start = idx * base + Math.min(idx, rem);
  const size = base + (idx < rem ? 1 : 0);
  return items.slice(start, start + size);
}
