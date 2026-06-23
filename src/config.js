const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

module.exports = {
  port: parseInt(process.env.PORT || "3001", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  apiSecret: process.env.API_SECRET || "",
  logLevel: process.env.LOG_LEVEL || "warn",
  databaseUrl: process.env.DATABASE_URL || "",
  // Forward incoming WhatsApp messages to an n8n webhook (CS bot for tenants).
  // Only sessions listed in n8nWebhookTenants are forwarded (default: superadmin only),
  // so tenant↔customer chats are never sent to n8n.
  n8nWebhookUrl: process.env.N8N_WEBHOOK_URL || "",
  n8nWebhookTenants: (process.env.N8N_WEBHOOK_TENANTS || "superadmin")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};
