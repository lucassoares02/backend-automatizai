const pool = require("../db");

// Cache de existência de colunas — tolera migrations ainda NÃO aplicadas
// manualmente (ex.: `menu_items.dietary_restrictions` antes da FASE do
// DB_CHANGES_NEEDED.md). Assim uma coluna nova referenciada no código não
// quebra as queries em produção enquanto o ALTER não roda; quando a coluna
// passar a existir, basta reiniciar o processo para o cache refletir.
const _cache = new Map();

const columnExists = async (table, column) => {
  const key = `${table}.${column}`;
  if (_cache.has(key)) return _cache.get(key);
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
  _cache.set(key, exists);
  return exists;
};

module.exports = { columnExists };
