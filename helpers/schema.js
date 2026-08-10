const pool = require("../db");

// Cache de existência de colunas — tolera migrations ainda NÃO aplicadas
// manualmente (ex.: `menu_items.dietary_restrictions` antes da FASE do
// DB_CHANGES_NEEDED.md). Assim uma coluna nova referenciada no código não
// quebra as queries em produção enquanto o ALTER não roda.
//
// IMPORTANTE — assimetria de cache:
//   • "existe" (true)  → estado PERMANENTE: cacheia para sempre.
//   • "não existe" (false) → estado TRANSITÓRIO: alguém pode rodar o ALTER a
//     qualquer momento. Cacheamos só por um curto TTL e re-consultamos depois,
//     para o código passar a usar a coluna sozinho (sem reiniciar o processo)
//     assim que a migration for aplicada.
const _positive = new Set(); // colunas confirmadas como existentes
const _negativeUntil = new Map(); // coluna -> timestamp até quando "não existe" vale
const NEGATIVE_TTL_MS = 30_000;

const columnExists = async (table, column) => {
  const key = `${table}.${column}`;
  if (_positive.has(key)) return true;
  const until = _negativeUntil.get(key);
  if (until && Date.now() < until) return false;

  let exists = false;
  try {
    const r = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2 LIMIT 1`,
      [table, column],
    );
    exists = r.rowCount > 0;
  } catch (_) {
    exists = false;
  }

  if (exists) {
    _positive.add(key);
    _negativeUntil.delete(key);
  } else {
    _negativeUntil.set(key, Date.now() + NEGATIVE_TTL_MS);
  }
  return exists;
};

module.exports = { columnExists };
