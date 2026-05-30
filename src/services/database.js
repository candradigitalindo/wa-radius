const { Pool } = require("pg");
const config = require("../config");
const pino = require("pino");

const logger = pino({ level: config.logLevel });

let pool = null;

/**
 * Initialize PostgreSQL connection pool and create tables if they don't exist.
 */
async function initDatabase() {
  if (!config.databaseUrl) {
    throw new Error("DATABASE_URL is required. Set it in .env or environment variables.");
  }

  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  pool.on("error", (err) => {
    logger.error({ err: err.message }, "Unexpected PG pool error");
  });

  // Test connection
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    logger.info("PostgreSQL connected successfully");
  } finally {
    client.release();
  }

  // Auto-create tables
  await createTables();
}

/**
 * Create all required tables for WA session storage.
 */
async function createTables() {
  const queries = [
    // Main credentials per tenant (creds.json)
    `CREATE TABLE IF NOT EXISTS wa_auth_creds (
      tenant_id VARCHAR(64) PRIMARY KEY,
      creds JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // All auth keys (pre-keys, sessions, app-state-sync-keys, sender-keys)
    `CREATE TABLE IF NOT EXISTS wa_auth_keys (
      tenant_id VARCHAR(64) NOT NULL,
      key_type VARCHAR(64) NOT NULL,
      key_id VARCHAR(255) NOT NULL,
      key_data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tenant_id, key_type, key_id)
    )`,

    // Daily send counter
    `CREATE TABLE IF NOT EXISTS wa_daily_counts (
      tenant_id VARCHAR(64) NOT NULL,
      count_date DATE NOT NULL,
      send_count INT DEFAULT 0,
      PRIMARY KEY (tenant_id, count_date)
    )`,

    // Session metadata (status, device info)
    `CREATE TABLE IF NOT EXISTS wa_session_status (
      tenant_id VARCHAR(64) PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'inactive',
      device_phone VARCHAR(32),
      device_name VARCHAR(255),
      device_platform VARCHAR(64),
      connected_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,

    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_wa_auth_keys_tenant ON wa_auth_keys(tenant_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_session_status_status ON wa_session_status(status)`,
    `CREATE INDEX IF NOT EXISTS idx_wa_daily_counts_date ON wa_daily_counts(count_date)`,
  ];

  for (const query of queries) {
    await pool.query(query);
  }

  logger.info("WA session tables verified/created");
}

/**
 * Get the PG pool. Throws if not initialized.
 */
function getPool() {
  if (!pool) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return pool;

}

/**
 * Close all PG connections gracefully.
 */
async function closeDatabase() {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info("PostgreSQL pool closed");
  }
}

module.exports = { initDatabase, getPool, closeDatabase };