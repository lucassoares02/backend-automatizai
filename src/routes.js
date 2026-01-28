const express = require("express");
const router = express.Router();
const user = require("../controllers/userController");
const login = require("../controllers/loginController");
const authMiddleware = require("../src/middlewares/middleware");
const mailer = require("../controllers/maillerController");
const register = require("../controllers/registerController");
const companies = require("../controllers/companiesController");
const account = require("../controllers/accountController");
const company_opening_hours = require("../controllers/company_opening_hoursController");
const menu_categories = require("../controllers/menu_categoriesController");
const menu_items = require("../controllers/menu_itemsController");

router.get("/", (req, res) => {
  res.send("API is running 🚀");
});

router.post("/signin", login.signin);

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
router.get("/company_opening_hours/:id", company_opening_hours.find);
router.post("/company_opening_hours", company_opening_hours.create);
router.patch("/company_opening_hours/:id", company_opening_hours.update);
router.delete("/company_opening_hours/:id", company_opening_hours.remove);

//menu_categories
router.get("/menu_categories", menu_categories.findAll);
router.get("/menu_categories/:id", menu_categories.find);
router.post("/menu_categories", menu_categories.create);
router.patch("/menu_categories/:id", menu_categories.update);
router.delete("/menu_categories/:id", menu_categories.remove);

//menu_items
router.get("/menu_items", menu_items.findAll);
router.get("/menu_items/:id", menu_items.find);
router.post("/menu_items", menu_items.create);
router.patch("/menu_items/:id", menu_items.update);
router.delete("/menu_items/:id", menu_items.remove);

module.exports = router;
