const express = require("express");
const router = express.Router();
const user = require("../controllers/userController");
const login = require("../controllers/loginController");
const googleAuth = require("../controllers/googleAuthController");
const authMiddleware = require("../src/middlewares/middleware");
const { authorizeCompanyParam, authorizeCompanyBody, authorizeByLookup } = require("../src/middlewares/authorize");
const rateLimit = require("../src/middlewares/rateLimit");
const mailer = require("../controllers/maillerController");
const register = require("../controllers/registerController");
const companies = require("../controllers/companiesController");
const account = require("../controllers/accountController");
const company_opening_hours = require("../controllers/company_opening_hoursController");
const menu_categories = require("../controllers/menu_categoriesController");
const menu_items = require("../controllers/menu_itemsController");
const companiessss = require("../controllers/companiessssController");
const company = require("../controllers/company_address_Controller");
const payment_methods = require("../controllers/payment_methodsController");
const connections = require("../controllers/connectionsController");
const additional_info = require("../controllers/additional_infoController");
const orders = require("../controllers/ordersController");
const clients = require("../controllers/clientsController");
const publicCtrl = require("../controllers/publicController");
const dashboard = require("../controllers/dashboardController");
const address = require("../controllers/addressController");
const promotions = require("../controllers/promotionsController");
const campaigns = require("../controllers/campaignsController");
const upsell = require("../controllers/upsellController");
const searchAnalytics = require("../controllers/searchAnalyticsController");
const orderMessages = require("../controllers/orderMessagesController");
const productOptions = require("../controllers/productOptionsController");
const purchaseGoals = require("../controllers/purchaseGoalsController");
const customerTracking = require("../controllers/customerTrackingController");
const ifoodImport = require("../controllers/ifoodImportController");
const deliveries = require("../controllers/deliveriesController");
const deliveryDrivers = require("../controllers/deliveryDriversController");
const stripe = require("../controllers/stripeController");

// ─── Rate limiters ───────────────────────────────────────────────────────────
// Estritos para autenticação/abuso; generosos para o fluxo público de pedidos
// (não afeta o volume normal). Ajuste os valores conforme telemetria de produção.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, scope: "auth", message: "Muitas tentativas. Aguarde alguns minutos." });
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, scope: "public" });
const googleLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, scope: "google" });

// ─── Autorização por objeto (resolve a empresa dona via id do recurso) ─────────
const authorizeOrder = authorizeByLookup("SELECT company_id FROM orders WHERE id = $1", "id");
const authorizeOrderByOrderId = authorizeByLookup("SELECT company_id FROM orders WHERE id = $1", "orderId");
const authorizeClient = authorizeByLookup("SELECT company_id FROM clients WHERE id = $1", "id");
const authorizePromotion = authorizeByLookup("SELECT company_id FROM promotions WHERE id = $1", "id");
const authorizeCampaign = authorizeByLookup("SELECT company_id FROM campaigns WHERE id = $1", "id");
const authorizeUpsell = authorizeByLookup("SELECT company_id FROM upsell_rules WHERE id = $1", "id");
const authorizeGoal = authorizeByLookup("SELECT company_id FROM purchase_goals WHERE id = $1", "id");
const authorizeDriver = authorizeByLookup("SELECT company_id FROM delivery_drivers WHERE id = $1", "id");
const authorizeConnection = authorizeByLookup("SELECT company_id FROM connections WHERE id = $1", "id");

// ─── Webhook (opt-in): exige um segredo só se EVOLUTION_WEBHOOK_TOKEN estiver
// configurado. Assim não quebra a integração atual até o Evolution ser ajustado.
const verifyWebhookToken = (req, res, next) => {
  const expected = process.env.EVOLUTION_WEBHOOK_TOKEN;
  if (!expected) return next(); // não configurado → mantém comportamento atual
  const got = req.headers["x-webhook-token"] || req.query.token;
  if (got !== expected) return res.status(401).json({ error: "unauthorized webhook" });
  next();
};

router.get("/", (req, res) => {
  res.send("API is running 🚀");
});

router.post("/signin", authLimiter, login.signin);
router.post("/auth/google", authLimiter, googleAuth.googleSignIn);

// USER
router.get("/users", authMiddleware, user.getAllUsers);
router.post("/users", authMiddleware, user.createUser);

// SEND EMAIL — rate-limited para evitar abuso como relay de spam.
router.post("/send-email", authLimiter, mailer.sendEmail);

// Fluxo de cadastro (pré-login): permanece público, apenas rate-limited.
router.post("/register", authLimiter, register.create);
router.post("/companies/withoutid", authMiddleware, register.createCompaniesWithoutId);
router.post("/companies", authLimiter, register.createCompanies);
router.get("/cnpj/:cnpj", authLimiter, register.find);

router.get("/companies", authMiddleware, companies.find);
router.patch("/companies", authMiddleware, authorizeCompanyBody("id"), companies.update);
router.get("/companies/:company", authMiddleware, authorizeCompanyParam("company"), companies.findId);
router.get("/providers/city/:company", authMiddleware, authorizeCompanyParam("company"), companies.findProvidersCity);

router.get("/account", authMiddleware, account.find);
router.patch("/account", authMiddleware, account.update);

//company_opening_hours
router.get("/company_opening_hours", company_opening_hours.findAll);
router.get("/company_opening_hours/company/:id", company_opening_hours.findByCompany);
router.get("/company_opening_hours/:id", company_opening_hours.find);
router.post("/company_opening_hours", authMiddleware, company_opening_hours.create);
router.patch("/company_opening_hours/:id", authMiddleware, company_opening_hours.update);
router.delete("/company_opening_hours/:id", authMiddleware, company_opening_hours.remove);

//menu_categories
router.get("/menu_categories", menu_categories.findAll);
router.get("/menu_categories/company/:companyId", menu_categories.findByCompany);
router.get("/menu_categories/:id", menu_categories.find);
router.post("/menu_categories", authMiddleware, menu_categories.create);
router.patch("/menu_categories/:id", authMiddleware, menu_categories.update);
router.delete("/menu_categories/:id", authMiddleware, menu_categories.remove);

//ifood import (preenchimento automático de cardápio)
router.post("/ifood/import-preview", authMiddleware, ifoodImport.importPreview);
router.post("/ifood/import", authMiddleware, ifoodImport.importMenu);

//menu_items
router.get("/menu_items", menu_items.findAll);
router.get("/menu_items/company/:id", menu_items.findByCompany);
router.get("/menu_items/:id", menu_items.find);
router.post("/menu_items/upload-image", authMiddleware, menu_items.upload.single("image"), menu_items.uploadImage);
router.post("/menu_items", authMiddleware, menu_items.create);
router.patch("/menu_items", authMiddleware, menu_items.update);
router.delete("/menu_items/:id", authMiddleware, menu_items.remove);

router.get("/company/address/:id", company.find);
router.patch("/company/address", authMiddleware, company.update);

//companiessss
router.get("/companiessss", companiessss.findAll);
router.get("/companiessss/:id", companiessss.find);
router.post("/companiessss/upload-image", authMiddleware, companiessss.upload.single("image"), companiessss.uploadImage);
router.post("/companiessss", authMiddleware, companiessss.create);
router.patch("/companiessss", authMiddleware, companiessss.update);
router.delete("/companiessss/:id", authMiddleware, companiessss.remove);

//payment_methods
router.get("/payment_methods", payment_methods.findAll);
router.get("/payment_methods/:id", payment_methods.find);
router.get("/payment_methods/company/:id", payment_methods.findByCompany);
router.post("/payment_methods", authMiddleware, payment_methods.create);
router.patch("/payment_methods/:id", authMiddleware, payment_methods.update);
router.delete("/payment_methods/:id", authMiddleware, payment_methods.remove);

//connections
router.post("/connections/webhook", verifyWebhookToken, connections.webhook); // chamado pela Evolution API
router.get("/connections/all/:company", authMiddleware, authorizeCompanyParam("company"), connections.findAll);
router.get("/connections/qrcode/:instance", authMiddleware, connections.getQrCode);
router.get("/connections/test/:instance", authMiddleware, connections.testConnection);
router.get("/connections/status/:instance", authMiddleware, connections.getStatus);
router.get("/connections/:id", authMiddleware, authorizeConnection, connections.find);
router.post("/connections", authMiddleware, authorizeCompanyBody(), connections.create);
router.patch("/connections/:id", authMiddleware, authorizeConnection, connections.update);
router.post("/connections/:id/update-workflow", authMiddleware, authorizeConnection, connections.updateWorkflow);
router.delete("/connections/:id/:instance", authMiddleware, authorizeConnection, connections.remove);
router.post("/search-address", authMiddleware, connections.searchAddress);

//additional_info
router.get("/additional_info/company/:id", additional_info.findAll);
router.get("/additional_info/:id", additional_info.find);
router.post("/additional_info", authMiddleware, additional_info.create);
router.patch("/additional_info/:id", authMiddleware, additional_info.update);
router.delete("/additional_info/:id", authMiddleware, additional_info.remove);

//clients
router.get("/clients/company/:id/summary", authMiddleware, authorizeCompanyParam("id"), clients.getSummary);
router.get("/clients/company/:id", authMiddleware, authorizeCompanyParam("id"), clients.findAllWithStats);
router.get("/clients/:id/details", authMiddleware, authorizeClient, clients.getDetails);
router.get("/clients/:id", authMiddleware, authorizeClient, clients.find);
router.post("/clients", authMiddleware, authorizeCompanyBody(), clients.create);
router.patch("/clients/:id", authMiddleware, authorizeClient, clients.update);
router.delete("/clients/:id", authMiddleware, authorizeClient, clients.remove);

// order messages (admin)
router.get("/orders/:orderId/messages", authMiddleware, authorizeOrderByOrderId, orderMessages.adminList);
router.post("/orders/:orderId/messages", authMiddleware, authorizeOrderByOrderId, orderMessages.adminSend);
router.patch("/orders/:orderId/messages/read", authMiddleware, authorizeOrderByOrderId, orderMessages.markRead);

//orders
router.get("/orders/company/:id", authMiddleware, authorizeCompanyParam("id"), orders.findByCompany);
router.get("/orders/today/:id", authMiddleware, authorizeCompanyParam("id"), orders.findTodayByCompany);
router.get("/orders/summary/:id", authMiddleware, authorizeCompanyParam("id"), orders.summarize);
router.get("/orders/:id", authMiddleware, authorizeOrder, orders.find);
router.post("/orders", authMiddleware, authorizeCompanyBody(), orders.create);
router.patch("/orders/:id/status", authMiddleware, authorizeOrder, orders.updateStatus);
router.delete("/orders/:id", authMiddleware, authorizeOrder, orders.remove);

// deliveries — gestão inteligente de entregas (pedidos em rota + rotas otimizadas)
router.get("/deliveries/active/:companyId", authMiddleware, authorizeCompanyParam("companyId"), deliveries.getActive);
router.post("/deliveries/routes", authMiddleware, authorizeCompanyBody(), deliveries.createRoute);
router.get("/deliveries/routes/:companyId", authMiddleware, authorizeCompanyParam("companyId"), deliveries.listRoutes);

// delivery drivers — motoboys (CRUD)
router.get("/delivery-drivers/company/:companyId", authMiddleware, authorizeCompanyParam("companyId"), deliveryDrivers.findByCompany);
router.post("/delivery-drivers", authMiddleware, authorizeCompanyBody(), deliveryDrivers.create);
router.put("/delivery-drivers/:id", authMiddleware, authorizeDriver, deliveryDrivers.update);
router.patch("/delivery-drivers/:id", authMiddleware, authorizeDriver, deliveryDrivers.update);
router.delete("/delivery-drivers/:id", authMiddleware, authorizeDriver, deliveryDrivers.remove);

//dashboard (aggregated executive view)
router.get("/dashboard/:companyId", authMiddleware, authorizeCompanyParam("companyId"), dashboard.getDashboard);

// promotions / combos
router.get("/promotions/company/:companyId", authMiddleware, authorizeCompanyParam("companyId"), promotions.findByCompany);
router.post("/promotions", authMiddleware, authorizeCompanyBody(), promotions.create);
router.patch("/promotions/:id", authMiddleware, authorizePromotion, promotions.update);
router.patch("/promotions/:id/status", authMiddleware, authorizePromotion, promotions.toggleStatus);
router.delete("/promotions/:id", authMiddleware, authorizePromotion, promotions.remove);

// campaigns (marketing via IA/n8n)
router.post("/campaigns/webhook/report", campaigns.webhookReport); // callback do n8n (Basic Auth no controller)
router.get("/campaigns/company/:companyId", authMiddleware, authorizeCompanyParam("companyId"), campaigns.findByCompany);
router.get("/campaigns/company/:companyId/audience-preview", authMiddleware, authorizeCompanyParam("companyId"), campaigns.audiencePreview);
router.get("/campaigns/:id", authMiddleware, authorizeCampaign, campaigns.find);
router.post("/campaigns", authMiddleware, authorizeCompanyBody(), campaigns.create);
router.patch("/campaigns/:id", authMiddleware, authorizeCampaign, campaigns.update);
router.post("/campaigns/:id/dispatch", authMiddleware, authorizeCampaign, campaigns.dispatch);
router.delete("/campaigns/:id", authMiddleware, authorizeCampaign, campaigns.remove);

// upsell rules (authenticated)
router.get("/upsell/company/:companyId", authMiddleware, authorizeCompanyParam("companyId"), upsell.findByCompany);
router.post("/upsell", authMiddleware, authorizeCompanyBody(), upsell.create);
router.patch("/upsell/:id", authMiddleware, authorizeUpsell, upsell.update);
router.patch("/upsell/:id/status", authMiddleware, authorizeUpsell, upsell.toggleStatus);
router.post("/upsell/:id/duplicate", authMiddleware, authorizeUpsell, upsell.duplicate);
router.delete("/upsell/:id", authMiddleware, authorizeUpsell, upsell.remove);

// upsell public — no auth
router.get("/public/upsell/suggestions", publicLimiter, upsell.getSuggestions);

// search analytics — public ingest (no auth), report endpoints (auth)
router.post("/public/search-analytics", publicLimiter, searchAnalytics.track);
router.get("/search-analytics/top-terms/:companyId", authMiddleware, authorizeCompanyParam("companyId"), searchAnalytics.topTerms);
router.get("/search-analytics/top-products/:companyId", authMiddleware, authorizeCompanyParam("companyId"), searchAnalytics.topProducts);
router.get("/search-analytics/no-results/:companyId", authMiddleware, authorizeCompanyParam("companyId"), searchAnalytics.noResults);

// address (Google Places autocomplete/details — público, rate-limited p/ proteger cota)
router.get("/address/autocomplete", googleLimiter, address.autocomplete);
router.get("/address/details/:placeId", googleLimiter, address.details);

// order messages (public — phone-verified)
router.get("/public/orders/:orderId/messages", publicLimiter, orderMessages.publicList);
router.post("/public/orders/:orderId/messages", publicLimiter, orderMessages.publicSend);

// product options / additionals
router.post("/product-options/upload-item-image", authMiddleware, productOptions.upload.single("image"), productOptions.uploadImage);
router.get("/product-options/product/:productId", authMiddleware, productOptions.findByProduct);
router.post("/product-options", authMiddleware, productOptions.create);
router.patch("/product-options/reorder/:productId", authMiddleware, productOptions.reorder);
router.patch("/product-options/:groupId", authMiddleware, productOptions.update);
router.delete("/product-options/:groupId", authMiddleware, productOptions.remove);
router.get("/public/product-options/:productId", publicLimiter, productOptions.publicFindByProduct);

// purchase goals (objetivo de compra)
router.get("/purchase-goals/company/:companyId", authMiddleware, authorizeCompanyParam("companyId"), purchaseGoals.findByCompany);
router.post("/purchase-goals", authMiddleware, authorizeCompanyBody(), purchaseGoals.create);
router.patch("/purchase-goals/:id/status", authMiddleware, authorizeGoal, purchaseGoals.setStatus);
router.patch("/purchase-goals/:id", authMiddleware, authorizeGoal, purchaseGoals.update);
router.delete("/purchase-goals/:id", authMiddleware, authorizeGoal, purchaseGoals.remove);
router.post("/public/purchase-goals/suggest", publicLimiter, purchaseGoals.publicSuggest);

// public ordering (no auth) — FLUXO CRÍTICO DE PEDIDOS: mantido público.
router.get("/public/restaurants", publicLimiter, publicCtrl.listRestaurants);
router.get("/public/company/:companyId", publicLimiter, publicCtrl.getCompanyMenu);
router.get("/public/delivery-fee", publicLimiter, publicCtrl.calculateDeliveryFee);
router.get("/public/client", publicLimiter, publicCtrl.findClientByPhone);
router.post("/public/clients", publicLimiter, publicCtrl.createClient);
router.patch("/public/clients/:id", publicLimiter, publicCtrl.updateClient);
router.post("/public/orders", publicLimiter, publicCtrl.createOrder);
router.get("/public/orders", publicLimiter, publicCtrl.listOrdersByPhone);
router.get("/public/orders/:id/reorder", publicLimiter, publicCtrl.reorder);
router.get("/public/orders/:id", publicLimiter, publicCtrl.getOrder);

// customer tracking — público (fire-and-forget) e admin (com auth)
router.post("/public/customer-tracking/session", publicLimiter, customerTracking.upsertSession);
router.post("/public/customer-tracking/location", publicLimiter, customerTracking.updateLocation);
router.post("/public/customer-tracking/order", publicLimiter, customerTracking.attachOrder);
router.post("/public/customer-tracking/event", publicLimiter, customerTracking.trackEvent);
router.get("/customer-tracking/company/:companyId/sessions", authMiddleware, authorizeCompanyParam("companyId"), customerTracking.listSessions);
router.get("/customer-tracking/company/:companyId/map", authMiddleware, authorizeCompanyParam("companyId"), customerTracking.listMapPoints);
router.get("/customer-tracking/company/:companyId/metrics", authMiddleware, authorizeCompanyParam("companyId"), customerTracking.getMetrics);
router.get("/customer-tracking/company/:companyId/session/:sessionId/events", authMiddleware, authorizeCompanyParam("companyId"), customerTracking.listSessionEvents);
router.post("/customer-tracking/company/:companyId/session/:sessionId/abandonment", authMiddleware, authorizeCompanyParam("companyId"), customerTracking.notifyAbandonment);

// ─── Stripe (pagamentos online — contas conectadas) ───────────────────────────
// Comerciante (autenticado): onboarding Connect + status da conta.
router.post("/stripe/connect", authMiddleware, authorizeCompanyBody(), stripe.connect);
router.get("/stripe/status/:companyId", authMiddleware, authorizeCompanyParam("companyId"), stripe.status);
// Cliente (público, rate-limited): cria a sessão de checkout de um pedido.
router.post("/public/stripe/checkout", publicLimiter, stripe.createCheckout);
// Pagamento embutido (Payment Element) — cliente paga sem sair da plataforma.
router.post("/public/stripe/payment-intent", publicLimiter, stripe.createPaymentIntent);
// Webhook Stripe (sem auth; assinatura verificada no controller; corpo RAW em index.js).
router.post("/stripe/webhook", stripe.webhook);

module.exports = router;
