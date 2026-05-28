const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

module.exports = {
  port: parseInt(process.env.PORT || "3001", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  apiSecret: process.env.API_SECRET || "",
  logLevel: process.env.LOG_LEVEL || "info",
  sessionDir: path.resolve(__dirname, "..", process.env.SESSION_DIR || "./sessions"),
};
