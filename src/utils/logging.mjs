/**
 * Logs por secção (orquestrador vs scrapers).
 */

const BAR = '═'.repeat(60);

/**
 * @param {string} sectionId — ex.: AULAS, DOCUMENTOS
 * @param {string} [detail] — linha opcional
 */
export function logSectionBanner(sectionId, detail = '') {
  console.log('');
  console.log(`[SEÇÃO] ${BAR}`);
  console.log(`[SEÇÃO]   ${sectionId}`);
  if (detail) console.log(`[SEÇÃO]   ${detail}`);
  console.log(`[SEÇÃO] ${BAR}`);
  console.log('');
}
