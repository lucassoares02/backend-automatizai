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

// Contexto de acesso do usuário: empresas vinculadas + flag de admin do sistema.
// Admin do sistema mantém o acesso PADRÃO, mas o `_isMember` passa a liberar
// qualquer empresa (ele enxerga/alterna entre todas as lojas).
const getUserAuthContext = async (userId) => {
  // Carregamento das empresas é crítico para a autorização; a flag de admin é
  // opcional e NÃO pode derrubar o acesso caso a coluna ainda não exista
  // (antes da migration). Por isso as consultas são independentes.
  const companyIds = await getUserCompanyIds(userId);
  let isSystemAdmin = false;
  try {
    const adminRes = await pool.query("SELECT is_system_admin FROM users WHERE id = $1", [userId]);
    isSystemAdmin = adminRes.rows[0]?.is_system_admin === true;
  } catch (e) {
    // Coluna is_system_admin ainda não migrada: trata como não-admin.
    isSystemAdmin = false;
  }
  return { companyIds, isSystemAdmin };
};

const _isMember = (req, companyId) => {
  // Admin do sistema tem acesso a todas as empresas.
  if (req.isSystemAdmin) return true;
  const cid = Number(companyId);
  if (!Number.isFinite(cid)) return false;
  const list = Array.isArray(req.userCompanies) ? req.userCompanies : [];
  return list.map(Number).includes(cid);
};

// Restringe uma rota a admins do sistema (ou ao principal de serviço).
const requireSystemAdmin = (req, res, next) => {
  if (req.isService || req.isSystemAdmin) return next();
  return res.status(403).json({ error: "Acesso restrito a administradores do sistema" });
};

const _deny = (res) => res.status(403).json({ error: "Acesso negado a esta empresa" });

/**
 * Autoriza quando o company_id vem direto de um parâmetro de rota.
 * Ex.: router.get("/orders/company/:id", authMiddleware, authorizeCompanyParam("id"), ...)
 */
const authorizeCompanyParam = (paramName = "companyId") => (req, res, next) => {
  if (req.isService) return next();
  const companyId = req.params[paramName];
  if (!companyId || !_isMember(req, companyId)) return _deny(res);
  next();
};

/**
 * Autoriza quando o company_id vem do corpo da requisição (create).
 */
const authorizeCompanyBody = (field = "company_id") => (req, res, next) => {
  if (req.isService) return next();
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
    if (req.isService) return next();
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
  getUserAuthContext,
  requireSystemAdmin,
  authorizeCompanyParam,
  authorizeCompanyBody,
  authorizeByLookup,
};
