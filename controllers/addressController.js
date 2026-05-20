const addressService = require('../services/addressService');

exports.autocomplete = async (req, res) => {
  const { input, sessionToken } = req.query;
  if (!input || input.trim().length < 2) {
    return res.status(200).json([]);
  }
  try {
    const results = await addressService.autocomplete(input.trim(), sessionToken);
    return res.status(200).json(results);
  } catch (err) {
    console.error('[address/autocomplete]', err.message);
    return res.status(500).json({ error: 'Falha na busca de endereços' });
  }
};

exports.details = async (req, res) => {
  const { placeId } = req.params;
  const { sessionToken } = req.query;
  if (!placeId) return res.status(400).json({ error: 'placeId obrigatório' });
  try {
    const result = await addressService.details(placeId, sessionToken);
    return res.status(200).json(result);
  } catch (err) {
    console.error('[address/details]', err.message);
    return res.status(500).json({ error: 'Falha ao obter detalhes do endereço' });
  }
};

exports.findByCompany = async (req, res) => {
  const { companyId } = req.params;
  try {
    const rows = await addressService.findByCompany(Number(companyId));
    return res.status(200).json(rows);
  } catch (err) {
    console.error('[address/findByCompany]', err.message);
    return res.status(500).json({ error: 'Falha ao listar endereços' });
  }
};

exports.create = async (req, res) => {
  try {
    const row = await addressService.create(req.body);
    return res.status(201).json(row);
  } catch (err) {
    console.error('[address/create]', err.message);
    return res.status(500).json({ error: 'Falha ao salvar endereço' });
  }
};

exports.remove = async (req, res) => {
  const { id } = req.params;
  try {
    const row = await addressService.remove(Number(id));
    if (!row) return res.status(404).json({ error: 'Endereço não encontrado' });
    return res.status(200).json(row);
  } catch (err) {
    console.error('[address/remove]', err.message);
    return res.status(500).json({ error: 'Falha ao remover endereço' });
  }
};
