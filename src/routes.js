const express = require("express");
const router = express.Router();
const user = require("../controllers/userController");
const login = require("../controllers/loginController");
const googleAuth = require("../controllers/googleAuthController");
const authMiddleware = require("../src/middlewares/middleware");
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
const upsell = require("../controllers/upsellController");
const searchAnalytics = require("../controllers/searchAnalyticsController");
const orderMessages = require("../controllers/orderMessagesController");
const productOptions = require("../controllers/productOptionsController");
const purchaseGoals = require("../controllers/purchaseGoalsController");
const customerTracking = require("../controllers/customerTrackingController");
const ifoodImport = require("../controllers/ifoodImportController");

router.get("/", (req, res) => {
  res.send("API is running 🚀");
});

router.post("/signin", login.signin);
router.post("/auth/google", googleAuth.googleSignIn);

// USER
router.get("/users", authMiddleware, user.getAllUsers);
router.post("/users", user.createUser);

// SEND EMAIL
router.post("/send-email", mailer.sendEmail);

router.post("/register", register.create);
router.post("/companies/withoutid", authMiddleware, register.createCompaniesWithoutId);
router.post("/companies", register.createCompanies);
router.get("/cnpj/:cnpj", register.find);

router.get("/companies", authMiddleware, companies.find);
router.patch("/companies", authMiddleware, companies.update);
router.get("/companies/:company", authMiddleware, companies.findId);
router.get("/providers/city/:company", authMiddleware, companies.findProvidersCity);

router.get("/account", authMiddleware, account.find);
router.patch("/account", authMiddleware, account.update);

//company_opening_hours
router.get("/company_opening_hours", company_opening_hours.findAll);
router.get("/company_opening_hours/company/:id", company_opening_hours.findByCompany);
router.get("/company_opening_hours/:id", company_opening_hours.find);
router.post("/company_opening_hours", company_opening_hours.create);
router.patch("/company_opening_hours/:id", company_opening_hours.update);
router.delete("/company_opening_hours/:id", company_opening_hours.remove);

//menu_categories
router.get("/menu_categories", menu_categories.findAll);
router.get("/menu_categories/company/:companyId", menu_categories.findByCompany);
router.get("/menu_categories/:id", menu_categories.find);
router.post("/menu_categories", menu_categories.create);
router.patch("/menu_categories/:id", menu_categories.update);
router.delete("/menu_categories/:id", menu_categories.remove);

//ifood import (preenchimento automático de cardápio)
router.post("/ifood/import-preview", ifoodImport.importPreview);
router.post("/ifood/import", ifoodImport.importMenu);

//menu_items
router.get("/menu_items", menu_items.findAll);
router.get("/menu_items/company/:id", menu_items.findByCompany);
router.get("/menu_items/:id", menu_items.find);
router.post("/menu_items/upload-image", authMiddleware, menu_items.upload.single("image"), menu_items.uploadImage);
router.post("/menu_items", menu_items.create);
router.patch("/menu_items", menu_items.update);
router.delete("/menu_items/:id", menu_items.remove);

router.get("/company/address/:id", company.find);
router.patch("/company/address", company.update);

//companiessss
router.get("/companiessss", companiessss.findAll);
router.get("/companiessss/:id", companiessss.find);
router.post("/companiessss/upload-image", authMiddleware, companiessss.upload.single("image"), companiessss.uploadImage);
router.post("/companiessss", companiessss.create);
router.patch("/companiessss", companiessss.update);
router.delete("/companiessss/:id", companiessss.remove);

//payment_methods
router.get("/payment_methods", payment_methods.findAll);
router.get("/payment_methods/:id", payment_methods.find);
router.get("/payment_methods/company/:id", payment_methods.findByCompany);
router.post("/payment_methods", payment_methods.create);
router.patch("/payment_methods/:id", payment_methods.update);
router.delete("/payment_methods/:id", payment_methods.remove);

//connections
router.post("/connections/webhook", connections.webhook); // no auth — called by Evolution API
router.get("/connections/all/:company", authMiddleware, connections.findAll);
router.get("/connections/qrcode/:instance", authMiddleware, connections.getQrCode);
router.get("/connections/test/:instance", authMiddleware, connections.testConnection);
router.get("/connections/status/:instance", authMiddleware, connections.getStatus);
router.get("/connections/:id", authMiddleware, connections.find);
router.post("/connections", authMiddleware, connections.create);
router.patch("/connections/:id", authMiddleware, connections.update);
router.post("/connections/:id/update-workflow", authMiddleware, connections.updateWorkflow);
router.delete("/connections/:id/:instance", authMiddleware, connections.remove);
router.post("/search-address", connections.searchAddress);

//additional_info
router.get("/additional_info/company/:id", additional_info.findAll);
router.get("/additional_info/:id", additional_info.find);
router.post("/additional_info", additional_info.create);
router.patch("/additional_info/:id", additional_info.update);
router.delete("/additional_info/:id", additional_info.remove);

//clients
router.get("/clients/company/:id/summary", authMiddleware, clients.getSummary);
router.get("/clients/company/:id", authMiddleware, clients.findAllWithStats);
router.get("/clients/:id/details", authMiddleware, clients.getDetails);
router.get("/clients/:id", authMiddleware, clients.find);
router.post("/clients", authMiddleware, clients.create);
router.patch("/clients/:id", authMiddleware, clients.update);
router.delete("/clients/:id", authMiddleware, clients.remove);

// order messages (admin)
router.get("/orders/:orderId/messages", authMiddleware, orderMessages.adminList);
router.post("/orders/:orderId/messages", authMiddleware, orderMessages.adminSend);
router.patch("/orders/:orderId/messages/read", authMiddleware, orderMessages.markRead);

//orders
router.get("/orders/company/:id", authMiddleware, orders.findByCompany);
router.get("/orders/today/:id", authMiddleware, orders.findTodayByCompany);
router.get("/orders/summary/:id", authMiddleware, orders.summarize);
router.get("/orders/:id", authMiddleware, orders.find);
router.post("/orders", authMiddleware, orders.create);
router.patch("/orders/:id/status", authMiddleware, orders.updateStatus);
router.delete("/orders/:id", authMiddleware, orders.remove);

//dashboard (aggregated executive view)
router.get("/dashboard/:companyId", authMiddleware, dashboard.getDashboard);

// promotions / combos
router.get("/promotions/company/:companyId", authMiddleware, promotions.findByCompany);
router.post("/promotions", authMiddleware, promotions.create);
router.patch("/promotions/:id", authMiddleware, promotions.update);
router.patch("/promotions/:id/status", authMiddleware, promotions.toggleStatus);
router.delete("/promotions/:id", authMiddleware, promotions.remove);

// upsell rules (authenticated)
router.get("/upsell/company/:companyId", authMiddleware, upsell.findByCompany);
router.post("/upsell", authMiddleware, upsell.create);
router.patch("/upsell/:id", authMiddleware, upsell.update);
router.patch("/upsell/:id/status", authMiddleware, upsell.toggleStatus);
router.post("/upsell/:id/duplicate", authMiddleware, upsell.duplicate);
router.delete("/upsell/:id", authMiddleware, upsell.remove);

// upsell public — no auth
router.get("/public/upsell/suggestions", upsell.getSuggestions);

// search analytics — public ingest (no auth), report endpoints (auth)
router.post("/public/search-analytics", searchAnalytics.track);
router.get("/search-analytics/top-terms/:companyId", authMiddleware, searchAnalytics.topTerms);
router.get("/search-analytics/top-products/:companyId", authMiddleware, searchAnalytics.topProducts);
router.get("/search-analytics/no-results/:companyId", authMiddleware, searchAnalytics.noResults);

// address (Google Places autocomplete/details — public, no token needed)
router.get("/address/autocomplete", address.autocomplete);
router.get("/address/details/:placeId", address.details);

// order messages (public — phone-verified)
router.get("/public/orders/:orderId/messages", orderMessages.publicList);
router.post("/public/orders/:orderId/messages", orderMessages.publicSend);

// product options / additionals
router.post("/product-options/upload-item-image", authMiddleware, productOptions.upload.single("image"), productOptions.uploadImage);
router.get("/product-options/product/:productId", authMiddleware, productOptions.findByProduct);
router.post("/product-options", authMiddleware, productOptions.create);
router.patch("/product-options/reorder/:productId", authMiddleware, productOptions.reorder);
router.patch("/product-options/:groupId", authMiddleware, productOptions.update);
router.delete("/product-options/:groupId", authMiddleware, productOptions.remove);
router.get("/public/product-options/:productId", productOptions.publicFindByProduct);

// purchase goals (objetivo de compra)
router.get("/purchase-goals/company/:companyId", authMiddleware, purchaseGoals.findByCompany);
router.post("/purchase-goals", authMiddleware, purchaseGoals.create);
router.patch("/purchase-goals/:id/status", authMiddleware, purchaseGoals.setStatus);
router.patch("/purchase-goals/:id", authMiddleware, purchaseGoals.update);
router.delete("/purchase-goals/:id", authMiddleware, purchaseGoals.remove);
router.post("/public/purchase-goals/suggest", purchaseGoals.publicSuggest);

// public ordering (no auth)
router.get("/public/company/:companyId", publicCtrl.getCompanyMenu);
router.get("/public/delivery-fee", publicCtrl.calculateDeliveryFee);
router.get("/public/client", publicCtrl.findClientByPhone);
router.post("/public/clients", publicCtrl.createClient);
router.patch("/public/clients/:id", publicCtrl.updateClient);
router.post("/public/orders", publicCtrl.createOrder);
router.get("/public/orders", publicCtrl.listOrdersByPhone);
router.get("/public/orders/:id/reorder", publicCtrl.reorder);
router.get("/public/orders/:id", publicCtrl.getOrder);

// customer tracking — público (fire-and-forget) e admin (com auth)
router.post("/public/customer-tracking/session", customerTracking.upsertSession);
router.post("/public/customer-tracking/location", customerTracking.updateLocation);
router.post("/public/customer-tracking/order", customerTracking.attachOrder);
router.post("/public/customer-tracking/event", customerTracking.trackEvent);
router.get("/customer-tracking/company/:companyId/sessions", authMiddleware, customerTracking.listSessions);
router.get("/customer-tracking/company/:companyId/map", authMiddleware, customerTracking.listMapPoints);
router.get("/customer-tracking/company/:companyId/metrics", authMiddleware, customerTracking.getMetrics);
router.get("/customer-tracking/company/:companyId/session/:sessionId/events", authMiddleware, customerTracking.listSessionEvents);

module.exports = router;
