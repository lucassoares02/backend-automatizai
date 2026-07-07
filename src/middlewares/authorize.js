// Autorização multi-tenant: garante que o usuário autenticado só acesse recursos
// de empresas às quais está vinculado (tabela user_companies).
//
// Pré-requisito: `authMiddleware` deve rodar antes e popular `req.userCompanies`
// (array de company_id do usuário). Estes middlewares comparam o company_id do
// recurso solicitado com essa lista e retornam 403 quando não há vínculo.
//
// Observação operacional: depende de `user_companies` estar corretamente
// populada. Empresas criadas pelo fluxo do app já registram esse vínculo
// (registerService.createCompanies). Vínculos legados eventualmente ausentes
// precisam ser inseridos para o usuário continuar acessando aquela empresa.

const pool = require("../../db");

const getUserCompanyIds = async (userId) => {
  const result = await pool.query(
    "SELECT company_id FROM user_companies WHERE user_id = $1",
    [userId],
  );
  return result.rows.map((r) => r.company_id);
};

const _isMember = (req, companyId) => {
  const cid = Number(companyId);
  if (!Number.isFinite(cid)) return false;
  const list = Array.isArray(req.userCompanies) ? req.userCompanies : [];
  return list.map(Number).includes(cid);
};

const _deny = (res) => res.status(403).json({ error: "Acesso negado a esta empresa" });

/**
 * Autoriza quando o company_id vem direto de um parâmetro de rota.
 * Ex.: router.get("/orders/company/:id", authMiddleware, authorizeCompanyParam("id"), ...)
 */
const authorizeCompanyParam = (paramName = "companyId") => (req, res, next) => {
  const companyId = req.params[paramName];
  if (!companyId || !_isMember(req, companyId)) return _deny(res);
  next();
};

/**
 * Autoriza quando o company_id vem do corpo da requisição (create).
 */
const authorizeCompanyBody = (field = "company_id") => (req, res, next) => {
  const companyId = req.body?.[field] ?? req.body?.companyId;
  if (!companyId || !_isMember(req, companyId)) return _deny(res);
  next();
};

/**
 * Autoriza recursos identificados por id de objeto, resolvendo a empresa dona
 * via uma query. `sql` deve selecionar uma coluna company_id a partir de $1 (id).
 * Ex.: authorizeByLookup("SELECT company_id FROM orders WHERE id = $1")
 */
const authorizeByLookup = (sql, paramName = "id") => async (req, res, next) => {
  try {
    const id = req.params[paramName];
    if (!id) return _deny(res);
    const result = await pool.query(sql, [id]);
    const companyId = result.rows[0]?.company_id;
    if (companyId == null) return res.status(404).json({ error: "Recurso não encontrado" });
    if (!_isMember(req, companyId)) return _deny(res);
    next();
  } catch (err) {
    console.error("authorizeByLookup error:", err.message);
    return res.status(500).json({ error: "Erro ao validar acesso" });
  }
};

module.exports = {
  getUserCompanyIds,
  authorizeCompanyParam,
  authorizeCompanyBody,
  authorizeByLookup,
};
