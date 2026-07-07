process.on("uncaughtException", (err) => {
  console.error("🔥 Uncaught Exception:");
  console.error(err.stack || err);
});

process.on("unhandledRejection", (reason) => {
  console.error("🔥 Unhandled Rejection:");
  console.error(reason?.stack || reason);
});

require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const routes = require("./src/routes");
const watchdogService = require("./services/watchdogService");
const cartAbandonmentService = require("./services/cartAbandonmentService");
const campaignSchedulerService = require("./services/campaignSchedulerService");
const messageQueueService = require("./services/messageQueueService");

// ─── CORS ────────────────────────────────────────────────────────────────────
// Allowlist a partir das variáveis de ambiente. Se nenhuma origem for configurada,
// mantém o comportamento permissivo anterior (evita quebrar ambientes ainda não
// ajustados), mas o recomendado em produção é definir ORIGIN/ALLOWED_ORIGIN.
const allowedOrigins = [process.env.ORIGIN, process.env.ALLOWED_ORIGIN]
  .filter(Boolean)
  .flatMap((v) => v.split(",").map((s) => s.trim()))
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Requisições sem Origin (curl, apps mobile, webhooks server-to-server) são
    // permitidas; a proteção de CORS é relevante apenas para navegadores.
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"));
  },
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
};

app.use(cors(corsOptions));
app.options(/^\/.*$/, cors(corsOptions));

// Webhook Stripe precisa do corpo RAW para validar a assinatura. Precisa vir
// ANTES do express.json (o body-parser marca req._body e o json seguinte pula).
app.use("/api/stripe/webhook", express.raw({ type: "*/*" }));

// Limite de tamanho de corpo — mitiga DoS por payload grande. Uploads de imagem
// usam multer (limite próprio de 10MB), não passam por aqui.
app.use(express.urlencoded({ extended: true, limit: "256kb" }));
app.use(express.json({ limit: "256kb" }));

app.use("/api/", routes);

// 👇 middleware de erro SEMPRE no final
app.use((err, req, res, next) => {
  console.error("🚨 Express Error:");
  console.error(err.stack || err);

  const status = err.status || 500;
  // Não vazar detalhes internos em 5xx; mensagens de 4xx (validação) são seguras.
  const message = status >= 500 ? "Erro interno do servidor" : err.message || "Requisição inválida";

  res.status(status).json({ success: false, message });
});

const PORT = process.env.PORT || 3003;

app
  .listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    watchdogService.start();
    cartAbandonmentService.start();
    campaignSchedulerService.start();
    messageQueueService.start();
  })
  .on("error", (err) => {
    console.error("❌ Server startup error:");
    console.error(err);
  });
