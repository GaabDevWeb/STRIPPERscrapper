import fs from 'fs/promises';

/**
 * Faz um sniff simples para HTML (respostas de login/permissão disfarçadas).
 * @param {Buffer} buf
 */
function bufferLooksLikeHtml(buf) {
  const head = Buffer.from(buf || Buffer.alloc(0))
    .toString('utf8')
    .trimStart()
    .slice(0, 256)
    .toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<head');
}

/**
 * Valida um ficheiro binário já no disco.
 *
 * Regras:
 * - deve existir e ser ficheiro
 * - size > 0
 * - não parecer HTML
 * - se `expectedBytes` fornecido, size deve bater (ou falha)
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {number} [opts.expectedBytes]
 * @returns {Promise<{ size: number }>}
 */
export async function validateBinaryFile(opts) {
  const filePath = opts.filePath;
  const expectedBytes = opts.expectedBytes;
  const st = await fs.stat(filePath);
  if (!st.isFile()) throw new Error('integrity: destino não é ficheiro');
  if (st.size <= 0) throw new Error('integrity: ficheiro vazio');
  if (Number.isFinite(expectedBytes) && expectedBytes >= 0 && st.size !== expectedBytes) {
    throw new Error(`integrity: tamanho ${st.size} != esperado ${expectedBytes}`);
  }

  const fh = await fs.open(filePath, 'r');
  try {
    const sniff = Buffer.alloc(96);
    await fh.read(sniff, 0, sniff.length, 0);
    if (bufferLooksLikeHtml(sniff)) {
      throw new Error('integrity: ficheiro parece HTML');
    }
  } finally {
    await fh.close().catch(() => {});
  }

  return { size: st.size };
}

export async function safeUnlink(filePath) {
  if (!filePath) return;
  await fs.unlink(filePath).catch(() => {});
}

