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

const corsOptions = {
  origin: `${process.env.ORIGIN}`,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
app.options(/^\/.*$/, cors());

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use("/api/", routes);

// 👇 middleware de erro SEMPRE no final
app.use((err, req, res, next) => {
  console.error("🚨 Express Error:");
  console.error(err.stack || err);

  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Erro interno do servidor",
  });
});

const PORT = process.env.PORT || 3003;

app
  .listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  })
  .on("error", (err) => {
    console.error("❌ Server startup error:");
    console.error(err);
  });
