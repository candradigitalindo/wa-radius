#!/usr/bin/env node

/**
 * Migration script: Import existing file-based WA sessions into PostgreSQL.
 *
 * This script reads session data from the `sessions/` directory (one subdirectory per tenant)
 * and imports all auth credentials, keys, and daily counts into the PostgreSQL tables
 * created by the database service.
 *
 * Usage:
 *   node scripts/migrate-file-to-pg.js
 *
 * Environment:
 *   DATABASE_URL — PostgreSQL connection string (required)
 *   SESSION_DIR  — Path to sessions directory (default: ./sessions)
 */

const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

// Load .env
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SESSION_DIR = path.resolve(__dirname, "..", process.env.SESSION_DIR || "./sessions");
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL environment variable is required.");
  console.error("Set it in wa-radius/.env or pass as environment variable.");
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

// Map filename prefixes to Baileys key types
// Baileys useMultiFileAuthState uses these prefixes:
const KEY_TYPE_MAP = {
  "pre-key-": "pre-key",
  "session-": "session",
  "sender-key-": "sender-key",
  "app-state-sync-key-": "app-state-sync-key",
  "app-state-sync-version-": "app-state-sync-version",
};

function classifyFile(filename) {
  for (const [prefix, keyType] of Object.entries(KEY_TYPE_MAP)) {
    if (filename.startsWith(prefix)) {
      const keyId = filename.slice(prefix.length).replace(/\.json$/, "");
      return { keyType, keyId };
    }
  }
  return null;
}

async function ensureTables() {
  const queries = [
    `CREATE TABLE IF NOT EXISTS wa_auth_creds (
      tenant_id VARCHAR(64) PRIMARY KEY,
      creds JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS wa_auth_keys (
      tenant_id VARCHAR(64) NOT NULL,
      key_type VARCHAR(64) NOT NULL,
      key_id VARCHAR(255) NOT NULL,
      key_data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tenant_id, key_type, key_id)
    )`,
    `CREATE TABLE IF NOT EXISTS wa_daily_counts (
      tenant_id VARCHAR(64) NOT NULL,
      count_date DATE NOT NULL,
      send_count INT DEFAULT 0,
      PRIMARY KEY (tenant_id, count_date)
    )`,
    `CREATE TABLE IF NOT EXISTS wa_session_status (
      tenant_id VARCHAR(64) PRIMARY KEY,
      status VARCHAR(32) NOT NULL DEFAULT 'inactive',
      device_phone VARCHAR(32),
      device_name VARCHAR(255),
      device_platform VARCHAR(64),
      connected_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];

  for (const q of queries) {
    await pool.query(q);
  }
  console.log("✓ Tables verified/created");
}

async function migrateTenant(tenantId, sessionDir) {
  const files = fs.readdirSync(sessionDir).filter((f) => f.endsWith(".json"));

  let credsFile = null;
  const keyFiles = [];

  for (const file of files) {
    if (file === "creds.json") {
      credsFile = file;
    } else {
      const classified = classifyFile(file);
      if (classified) {
        keyFiles.push({ ...classified, file });
      }
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1. Insert/update creds
    if (credsFile) {
      const credsData = JSON.parse(fs.readFileSync(path.join(sessionDir, credsFile), "utf-8"));
      await client.query(
        `INSERT INTO wa_auth_creds (tenant_id, creds, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (tenant_id)
         DO UPDATE SET creds = $2, updated_at = NOW()`,
        [tenantId, JSON.stringify(credsData)]
      );
      console.log(`  ✓ creds.json imported`);
    }

    // 2. Insert/update keys in batch
    let keyCount = 0;
    for (const kf of keyFiles) {
      try {
        const keyData = JSON.parse(fs.readFileSync(path.join(sessionDir, kf.file), "utf-8"));
        await client.query(
          `INSERT INTO wa_auth_keys (tenant_id, key_type, key_id, key_data, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (tenant_id, key_type, key_id)
           DO UPDATE SET key_data = $4, updated_at = NOW()`,
          [tenantId, kf.keyType, kf.keyId, JSON.stringify(keyData)]
        );
        keyCount++;
      } catch (err) {
        console.warn(`  ⚠ Skipping ${kf.file}: ${err.message}`);
      }
    }
    console.log(`  ✓ ${keyCount} auth keys imported`);

    // 3. Insert session status as inactive
    await client.query(
      `INSERT INTO wa_session_status (tenant_id, status, updated_at)
       VALUES ($1, 'inactive', NOW())
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId]
    );

    await client.query("COMMIT");
    console.log(`  ✓ Tenant ${tenantId} migration committed`);
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`  ✗ Tenant ${tenantId} migration failed: ${err.message}`);
    return false;
  } finally {
    client.release();
  }
}

async function migrateDailyCounts() {
  const countsFile = path.join(SESSION_DIR, ".daily-counts.json");
  if (!fs.existsSync(countsFile)) {
    console.log("ℹ No .daily-counts.json found, skipping daily counts migration");
    return;
  }

  const data = JSON.parse(fs.readFileSync(countsFile, "utf-8"));
  let count = 0;

  for (const [tenantId, record] of Object.entries(data)) {
    if (!record || !record.date || !record.count) continue;

    try {
      await pool.query(
        `INSERT INTO wa_daily_counts (tenant_id, count_date, send_count)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, count_date)
         DO UPDATE SET send_count = $3`,
        [tenantId, record.date, record.count]
      );
      count++;
    } catch (err) {
      console.warn(`  ⚠ Failed to migrate daily count for ${tenantId}: ${err.message}`);
    }
  }

  console.log(`✓ ${count} daily count records migrated`);
}

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  WA Session Migration: File → PostgreSQL");
  console.log("═══════════════════════════════════════════");
  console.log(`  Session dir: ${SESSION_DIR}`);
  console.log(`  Database:    ${DATABASE_URL.replace(/:([^@]+)@/, ":****@")}`);
  console.log();

  // Ensure tables exist
  await ensureTables();

  // Check if sessions directory exists
  if (!fs.existsSync(SESSION_DIR)) {
    console.log("No sessions directory found. Nothing to migrate.");
    await pool.end();
    return;
  }

  // Find tenant directories
  const dirs = fs
    .readdirSync(SESSION_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  if (dirs.length === 0) {
    console.log("No tenant session directories found. Nothing to migrate.");
    await pool.end();
    return;
  }

  console.log(`Found ${dirs.length} tenant(s) to migrate:\n`);

  let success = 0;
  let failed = 0;

  for (const tenantId of dirs) {
    console.log(`Migrating tenant: ${tenantId}`);
    const ok = await migrateTenant(tenantId, path.join(SESSION_DIR, tenantId));
    if (ok) success++;
    else failed++;
    console.log();
  }

  // Migrate daily counts
  await migrateDailyCounts();

  console.log("───────────────────────────────────────────");
  console.log(`  Migration complete: ${success} succeeded, ${failed} failed`);
  console.log("───────────────────────────────────────────");

  if (failed === 0) {
    console.log("\n✅ All sessions migrated successfully!");
    console.log("   You can now remove the sessions/ directory (or keep as backup).");
    console.log("   Start the WA service and sessions will be restored from PostgreSQL.");
  } else {
    console.log("\n⚠️  Some tenants failed to migrate. Check errors above.");
  }

  await pool.end();
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});