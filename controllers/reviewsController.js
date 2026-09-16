const service = require("../services/reviewsService");

// Público: o cliente envia a avaliação do pedido concluído (nota + mensagem).
const submitPublic = async (req, res) => {
  const { id } = req.params;
  const { phone, rating, comment } = req.body || {};
  if (!id || !String(id).trim()) {
    return res.status(400).json({ error: "Invalid order id" });
  }
  try {
    const result = await service.submitPublicReview({
      orderRef: String(id).trim(),
      phone: phone ? String(phone) : null,
      rating,
      comment,
    });
    if (!result.ok) {
      return res.status(result.code || 400).json({ error: result.message });
    }
    return res.status(200).json(result.review);
  } catch (error) {
    console.error("Error submitting order review:", error);
    return res.status(500).json({ error: "Failed to submit review" });
  }
};

// Painel: lista de avaliações da empresa.
const findByCompany = async (req, res) => {
  const { companyId } = req.params;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "Invalid company ID" });
  }
  try {
    const data = await service.findByCompany(Number(companyId));
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching reviews:", error);
    return res.status(500).json({ error: "Failed to fetch reviews" });
  }
};

// Painel: resumo (média, maior, menor, total, distribuição).
const summary = async (req, res) => {
  const { companyId } = req.params;
  if (!companyId || isNaN(companyId)) {
    return res.status(400).json({ error: "Invalid company ID" });
  }
  try {
    const data = await service.getSummary(Number(companyId));
    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching reviews summary:", error);
    return res.status(500).json({ error: "Failed to fetch reviews summary" });
  }
};

// Painel: comerciante responde a avaliação.
const respond = async (req, res) => {
  const { id } = req.params;
  const { response } = req.body || {};
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: "Invalid review id" });
  }
  try {
    const review = await service.respond(Number(id), response);
    if (!review) return res.status(404).json({ error: "Review not found" });
    return res.status(200).json(review);
  } catch (error) {
    console.error("Error responding to review:", error);
    // Honra erros com status/mensagem próprios (ex.: 503 de migração pendente).
    if (error?.status && error.status >= 400 && error.status < 600) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: "Failed to respond to review" });
  }
};

module.exports = { submitPublic, findByCompany, summary, respond };
