/**
 * Front-matter Markdown para aulas/transcrições.
 * Extraído de lessonScraper.js — campos preservados (title, source_url, course, transcript_file, downloaded_at).
 */
import fs from 'fs/promises';
import path from 'path';

function yamlScalar(value) {
  if (value == null) return '""';
  return JSON.stringify(String(value));
}

/**
 * @param {string} filePath — artefacto de transcrição
 * @param {{ title?: string, source_url?: string, course?: string, downloaded_at?: string }} metadata
 * @returns {Promise<string>} caminho do .md
 */
export async function toMarkdown(filePath, metadata) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const mdPath = path.join(dir, `${base}.md`);
  const downloadedAt = metadata.downloaded_at || new Date().toISOString();
  const content = [
    '---',
    `title: ${yamlScalar(metadata.title)}`,
    `source_url: ${yamlScalar(metadata.source_url)}`,
    `course: ${yamlScalar(metadata.course ?? '')}`,
    `transcript_file: ${yamlScalar(path.basename(filePath))}`,
    `downloaded_at: ${yamlScalar(downloadedAt)}`,
    '---',
    '',
    '',
  ].join('\n');
  await fs.writeFile(mdPath, content, 'utf8');
  return mdPath;
}
