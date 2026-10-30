const pool = require("../db");

const MAX_INT4 = 2147483647;

// Garante que os ids informados no corpo pertencem à empresa do recurso; senão
// lança erro 400. `table` é sempre um nome fixo no código, nunca vindo da requisição.
// A mensagem é a mesma para id de outra empresa e id inexistente, para não revelar
// quais registros existem nas demais empresas.
// `allowMissing`: aceita id que não existe mais. Serve para listas sem chave
// estrangeira, onde um registro apagado continua referenciado.
const assertIdsBelongToCompany = async (table, ids, companyId, message, { allowMissing = false } = {}) => {
  const list = (ids || []).filter((id) => id !== null && id !== undefined);
  if (!list.length) return;

  const reject = () => {
    throw Object.assign(new Error(message), { status: 400 });
  };
  if (!list.every((id) => Number.isInteger(id) && id > 0 && id <= MAX_INT4)) reject();

  const { rows } = await pool.query(`SELECT id, company_id FROM ${table} WHERE id = ANY($1::int[])`, [list]);
  const ownerOf = new Map(rows.map((r) => [Number(r.id), Number(r.company_id)]));
  for (const id of list) {
    if (ownerOf.has(id) ? ownerOf.get(id) !== Number(companyId) : !allowMissing) reject();
  }
};

module.exports = { assertIdsBelongToCompany };
