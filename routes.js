const express = require('express');
const router = express.Router();

// rotas registradas
const celularesRoutes = require('./celulares_routes');
router.use('/celulares', celularesRoutes);

module.exports = router;
