const crypto = require("crypto");

// Alfabeto da tag do pedido: letras maiúsculas + dígitos.
const TAG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const TAG_LENGTH = 6;
const MAX_ATTEMPTS = 12;

const _randomTag = () => {
  let tag = "";
  for (let i = 0; i < TAG_LENGTH; i++) {
    tag += TAG_ALPHABET[crypto.randomInt(TAG_ALPHABET.length)];
  }
  return tag;
};

/**
 * Gera uma tag única de 6 caracteres (A-Z, 0-9) para `orders.tag`.
 *
 * @param {{ query: Function }} db pool ou client de transação para checar duplicidade.
 * @returns {Promise<string>} tag inédita no banco.
 */
const generateUniqueOrderTag = async (db) => {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const tag = _randomTag();
    const res = await db.query("SELECT 1 FROM orders WHERE tag = $1 LIMIT 1", [tag]);
    if (res.rowCount === 0) return tag;
  }
  throw new Error("Não foi possível gerar uma tag única para o pedido");
};

module.exports = { generateUniqueOrderTag, TAG_LENGTH };
