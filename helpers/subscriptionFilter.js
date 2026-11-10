const { columnExists } = require("./schema");
const { notSubscriptionSql } = require("./subscriptionItem");

// Filtro que tira itens de assinatura das vendas avulsas (cardápio público,
// carrinho, agendamento e catálogo da IA). Vazio antes da migration.
const subscriptionFilter = async (alias) =>
  (await columnExists("menu_items", "subscription_enabled")) ? notSubscriptionSql(alias) : "";

module.exports = { subscriptionFilter };
