const { getPool } = require("./database");
const pino = require("pino");
const config = require("../config");
const { BufferJSON, initAuthCreds } = require("@whiskeysockets/baileys");

const logger = pino({ level: config.logLevel });

/**
 * Custom Baileys auth state adapter that stores all session data in PostgreSQL.
 */

/**
 * Recursively convert objects that look like serialized Buffers back into actual Buffers.
 * This is needed because PostgreSQL's jsonb type automatically parses JSON strings into
 * plain objects, but Baileys expects real Buffer instances.
 */
function fixBuffers(obj) {
  if (obj === null || obj === undefined) return obj;
  return JSON.parse(JSON.stringify(obj), BufferJSON.reviver);
}

/**
 * Create a PostgreSQL-backed auth state for a given tenant.
 */
async function usePgAuthState(tenantId) {
  const pool = getPool();

  // ─── Load or initialize credentials ───
  let credsResult = await pool.query(
    "SELECT creds FROM wa_auth_creds WHERE tenant_id = $1",
    [tenantId]
  );

  let creds;
  if (credsResult.rows.length === 0) {
    creds = initAuthCreds();

    await pool.query(
      "INSERT INTO wa_auth_creds (tenant_id, creds) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET creds = $2",
      [tenantId, JSON.stringify(creds, BufferJSON.replacer)]
    );
  } else {
    const rawCreds = typeof credsResult.rows[0].creds === "string"
      ? JSON.parse(credsResult.rows[0].creds)
      : credsResult.rows[0].creds;
    creds = fixBuffers(rawCreds);
  }

  // ─── Ensure session status row exists ───
  await pool.query(
    `INSERT INTO wa_session_status (tenant_id, status) VALUES ($1, 'connecting')
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId]
  );

  // ─── Build the key store (SignalKeyStore interface) ───
  const keys = {
    async get(type, ids) {
      if (!ids || ids.length === 0) return {};

      const result = await pool.query(
        "SELECT key_id, key_data FROM wa_auth_keys WHERE tenant_id = $1 AND key_type = $2 AND key_id = ANY($3)",
        [tenantId, type, ids]
      );

      const data = {};
      for (const row of result.rows) {
        const rawData = typeof row.key_data === "string"
          ? JSON.parse(row.key_data)
          : row.key_data;
        data[row.key_id] = fixBuffers(rawData);
      }
      return data;
    },

    async set(data) {
      const operations = [];
      for (const [type, entries] of Object.entries(data)) {
        for (const [id, value] of Object.entries(entries)) {
          operations.push({ type, id, value });
        }
      }

      if (operations.length === 0) return;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (const op of operations) {
          await client.query(
            `INSERT INTO wa_auth_keys (tenant_id, key_type, key_id, key_data, updated_at)
             VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (tenant_id, key_type, key_id)
             DO UPDATE SET key_data = $4, updated_at = NOW()`,
            [tenantId, op.type, op.id, JSON.stringify(op.value, BufferJSON.replacer)]
          );
        }

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async clear() {
      await pool.query("DELETE FROM wa_auth_keys WHERE tenant_id = $1", [tenantId]);
    },
  };

  // ─── saveCreds function (called on creds.update event) ───
  let _saveCredsTimer = null;
  let _pendingCreds = null;

  function saveCreds() {
    _pendingCreds = JSON.stringify(creds, BufferJSON.replacer);

    if (_saveCredsTimer) return;

    _saveCredsTimer = setTimeout(async () => {
      _saveCredsTimer = null;
      const dataToSave = _pendingCreds;
      _pendingCreds = null;

      if (!dataToSave) return;

      try {
        await pool.query(
          `INSERT INTO wa_auth_creds (tenant_id, creds, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (tenant_id)
           DO UPDATE SET creds = $2, updated_at = NOW()`,
          [tenantId, dataToSave]
        );
      } catch (err) {
        logger.error({ tenant: tenantId, err: err.message }, "Failed to save creds to PostgreSQL");
      }
    }, 250);
  }

  return { state: { creds, keys }, saveCreds };
}

/**
 * Delete all auth data for a tenant (creds + keys).
 * Used when a session is logged out or intentionally stopped.
 *
 * @param {string} tenantId
 */
async function deleteAuthData(tenantId) {
  const pool = getPool();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query("DELETE FROM wa_auth_keys WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM wa_auth_creds WHERE tenant_id = $1", [tenantId]);
    await client.query("DELETE FROM wa_session_status WHERE tenant_id = $1", [tenantId]);

    await client.query("COMMIT");
    logger.info({ tenant: tenantId }, "Auth data deleted from PostgreSQL");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Check if a tenant has auth data stored in the database.
 *
 * @param {string} tenantId
 * @returns {Promise<boolean>}
 */
async function hasAuthData(tenantId) {
  const pool = getPool();
  const result = await pool.query(
    "SELECT 1 FROM wa_auth_creds WHERE tenant_id = $1 LIMIT 1",
    [tenantId]
  );
  return result.rows.length > 0;
}

/**
 * Get all tenant IDs that have auth data stored.
 *
 * @returns {Promise<string[]>}
 */
async function getAllTenantIds() {
  const pool = getPool();
  const result = await pool.query("SELECT tenant_id FROM wa_auth_creds");
  return result.rows.map((r) => r.tenant_id);
}

module.exports = { usePgAuthState, deleteAuthData, hasAuthData, getAllTenantIds };