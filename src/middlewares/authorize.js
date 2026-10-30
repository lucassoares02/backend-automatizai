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

// Aceita somente inteiros canônicos (number inteiro ou string só de dígitos).
// Com Number() puro, "1e1" seria autorizado como empresa 10 e os controllers que
// usam parseInt agiriam sobre a empresa 1.
const _parseId = (value) => {
  if (typeof value !== "number" && !(typeof value === "string" && /^\d+$/.test(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
};

const _isMember = (req, companyId) => {
  // Admin do sistema tem acesso a todas as empresas.
  if (req.isSystemAdmin) return true;
  const cid = _parseId(companyId);
  if (cid === null) return false;
  const list = Array.isArray(req.userCompanies) ? req.userCompanies : [];
  return list.map(Number).includes(cid);
};

// Restringe uma rota a admins do sistema (ou ao principal de serviço).
const requireSystemAdmin = (req, res, next) => {
  if (req.isService || req.isSystemAdmin) return next();
  return res.status(403).json({ error: "Acesso restrito a administradores do sistema" });
};

// Somente admin do sistema autenticado por JWT. Diferente de requireSystemAdmin,
// NÃO libera o principal de serviço (API Key): ações de alto impacto em todas
// as empresas precisam de um usuário admin identificado.
const requireSystemAdminUser = (req, res, next) => {
  if (!req.isService && req.isSystemAdmin === true) return next();
  return res.status(403).json({ error: "Acesso restrito a administradores do sistema" });
};

// Administrador da conta (users.type = 0) ou administrador global. Diferente de
// requireSystemAdmin, este middleware não libera o principal de serviço: a
// cotação de entrega é, inicialmente, uma ação manual do comerciante.
const requireAdminUser = (req, res, next) => {
  if (req.isSystemAdmin || Number(req.user?.type) === 0) return next();
  return res.status(403).json({ error: "Acesso restrito a administradores" });
};

const _deny = (res) => res.status(403).json({ error: "Acesso negado a esta empresa" });

/**
 * Autoriza quando o company_id vem direto de um parâmetro de rota.
 * Ex.: router.get("/orders/company/:id", authMiddleware, authorizeCompanyParam("id"), ...)
 */
const authorizeCompanyParam = (paramName = "companyId") => (req, res, next) => {
  const companyId = req.params[paramName];
  if (req.isService) {
    req.authorizedCompanyId = companyId;
    return next();
  }
  if (!companyId || !_isMember(req, companyId)) return _deny(res);
  req.authorizedCompanyId = companyId;
  next();
};

/**
 * Autoriza quando o company_id vem do corpo da requisição (create).
 */
const authorizeCompanyBody = (field = "company_id") => (req, res, next) => {
  const companyId = req.body?.[field] ?? req.body?.companyId;
  if (req.isService) {
    req.authorizedCompanyId = companyId;
    return next();
  }
  if (!companyId || !_isMember(req, companyId)) return _deny(res);
  req.authorizedCompanyId = companyId;
  next();
};

/**
 * Autoriza recursos identificados por id de objeto, resolvendo a empresa dona
 * via uma query. `sql` deve selecionar uma coluna company_id a partir de $1 (id).
 * Ex.: authorizeByLookup("SELECT company_id FROM orders WHERE id = $1")
 */
const _authorizeLookup = (sql, readId) => async (req, res, next) => {
  try {
    if (req.isService) return next();
    const id = readId(req);
    if (!id) return _deny(res);
    const result = await pool.query(sql, [id]);
    const companyId = result.rows[0]?.company_id;
    if (companyId == null) return res.status(404).json({ error: "Recurso não encontrado" });
    if (!_isMember(req, companyId)) return _deny(res);
    req.authorizedCompanyId = companyId;
    next();
  } catch (err) {
    console.error("authorizeByLookup error:", err.message);
    return res.status(500).json({ error: "Erro ao validar acesso" });
  }
};

const authorizeByLookup = (sql, paramName = "id") => _authorizeLookup(sql, (req) => req.params[paramName]);

/**
 * Igual a authorizeByLookup, para rotas que recebem o id do recurso no corpo.
 * O id precisa ser canônico: é o mesmo valor que o controller vai usar no UPDATE.
 */
const authorizeByBodyLookup = (sql, field = "id") => _authorizeLookup(sql, (req) => _parseId(req.body?.[field]));

/**
 * Empresa sobre a qual o controller deve agir: a que o middleware da rota validou
 * (parâmetro, corpo ou dona do recurso). O company_id da query ou do corpo nunca
 * tem prioridade sobre ela. Só o principal de serviço, que não passa pelo lookup
 * e tem escopo global, pode informar a empresa nesses campos.
 */
const resolveCompanyId = (req) =>
  Number(req.authorizedCompanyId ?? (req.isService ? req.query?.company_id ?? req.body?.company_id : undefined));

/**
 * Corpo da requisição com a empresa fixada na que foi autorizada. Impede gravar em
 * outra empresa pelo alias companyId (que alguns services leem primeiro) e mover um
 * recurso em PATCH pelo company_id do corpo. O principal de serviço em rota por id
 * não tem empresa autorizada, e o corpo segue como veio.
 */
const companyScopedBody = (req) => {
  if (req.authorizedCompanyId == null) return req.body;
  const companyId = Number(req.authorizedCompanyId);
  return { ...req.body, company_id: companyId, companyId };
};

module.exports = {
  resolveCompanyId,
  companyScopedBody,
  getUserCompanyIds,
  getUserAuthContext,
  requireSystemAdmin,
  requireSystemAdminUser,
  requireAdminUser,
  authorizeCompanyParam,
  authorizeCompanyBody,
  authorizeByLookup,
  authorizeByBodyLookup,
};
