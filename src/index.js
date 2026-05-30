const express = require("express");
const pino = require("pino");
const config = require("./config");
const authMiddleware = require("./middleware/auth");
const sessionRoutes = require("./routes/session");
const messageRoutes = require("./routes/message");
const { initDatabase, closeDatabase } = require("./services/database");
const { restoreSessions, gracefulShutdown } = require("./services/session-manager");

const logger = pino({ level: config.logLevel });
const app = express();

app.use(express.json({ limit: "10mb" }));

// Health check (no auth required)
app.get("/health", async (_req, res) => {
  try {
    const { getPool } = require("./services/database");
    const pool = getPool();
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "whatsapp-service", database: "connected" });
  } catch {
    res.status(503).json({ status: "degraded", service: "whatsapp-service", database: "disconnected" });
  }
});

// All API routes require auth
app.use("/api", authMiddleware);
app.use("/api/sessions", sessionRoutes);
app.use("/api/messages", messageRoutes);

// Error handler
app.use((err, _req, res, _next) => {
  logger.error({ err: err.message, stack: err.stack }, "Unhandled error");
  res.status(500).json({ error: "Internal server error" });
});

async function main() {
  // Validate required configuration
  if (!config.apiSecret) {
    logger.fatal("API_SECRET environment variable is required. Set it in .env or environment.");
    process.exit(1);
  }

  // Initialize PostgreSQL connection and auto-create tables
  await initDatabase();

  // Restore existing sessions from database on startup
  await restoreSessions();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, "WhatsApp service started");
  });

  // Graceful shutdown: close all Baileys sockets + DB cleanly before exit
  const shutdown = async (signal) => {
    logger.info({ signal }, "Shutdown signal received, closing sessions...");
    await gracefulShutdown();
    await closeDatabase();
    server.close(() => {
      logger.info("HTTP server closed");
      process.exit(0);
    });
    // Force exit after 10s if graceful shutdown takes too long
    setTimeout(() => {
      logger.warn("Forced exit after timeout");
      process.exit(1);
    }, 10000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  logger.fatal({ err: err.message }, "Failed to start WhatsApp service");
  process.exit(1);
});
