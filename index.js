require("dotenv").config();
const express = require("express");
const app = express();
const cors = require("cors");
const routes = require("./src/routes");

// UPDATE CORS
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

const PORT = process.env.PORT || 3003;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
