const service = require("../services/adminStoresService");

// Gestão de lojas e vínculos de usuários. Somente admin do sistema autenticado
// por usuário (rotas protegidas por requireSystemAdminUser).

const STATUS_BY_CODE = {
  INVALID_EMAIL: 400,
  STORE_NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  LINK_NOT_FOUND: 404,
  ALREADY_LINKED: 409,
};

const _parseId = (value) => (typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null);

const _fail = (res, error, fallback) => {
  const status = STATUS_BY_CODE[error.code];
  if (status) return res.status(status).json({ success: false, code: error.code, error: error.message });
  console.error(fallback, error);
  return res.status(500).json({ success: false, error: fallback });
};

const listStores = async (req, res) => {
  try {
    return res.status(200).json({ success: true, data: await service.listStores() });
  } catch (error) {
    return _fail(res, error, "Falha ao listar as lojas");
  }
};

const listStoreUsers = async (req, res) => {
  const companyId = _parseId(req.params.companyId);
  if (!companyId) return res.status(400).json({ success: false, error: "Loja inválida" });
  try {
    return res.status(200).json({ success: true, data: await service.listStoreUsers(companyId) });
  } catch (error) {
    return _fail(res, error, "Falha ao listar os usuários da loja");
  }
};

const linkUser = async (req, res) => {
  const companyId = _parseId(req.params.companyId);
  if (!companyId) return res.status(400).json({ success: false, error: "Loja inválida" });
  try {
    const user = await service.linkUserByEmail(companyId, req.body?.email);
    console.log(`[admin-stores] Usuário ${user.id} vinculado à loja ${companyId} por ${req.user?.id}`);
    return res.status(201).json({ success: true, data: user });
  } catch (error) {
    return _fail(res, error, "Falha ao vincular o usuário");
  }
};

const unlinkUser = async (req, res) => {
  const companyId = _parseId(req.params.companyId);
  const userId = _parseId(req.params.userId);
  if (!companyId || !userId) return res.status(400).json({ success: false, error: "Parâmetros inválidos" });
  try {
    await service.unlinkUser(companyId, userId);
    console.log(`[admin-stores] Usuário ${userId} desvinculado da loja ${companyId} por ${req.user?.id}`);
    return res.status(200).json({ success: true });
  } catch (error) {
    return _fail(res, error, "Falha ao desvincular o usuário");
  }
};

module.exports = { listStores, listStoreUsers, linkUser, unlinkUser };
