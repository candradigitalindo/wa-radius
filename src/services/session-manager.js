const {
  default: makeWASocket,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const config = require("../config");
const { getPool } = require("./database");
const { usePgAuthState, deleteAuthData, hasAuthData, getAllTenantIds } = require("./pg-auth-state");

const logger = pino({ level: config.logLevel });

// Silent logger for Baileys internals — prevents massive log output from WA protocol events
// (signal decryption, presence updates, history sync, etc.)
const baileysLogger = pino({ level: "warn" });

// In-memory store of active sessions: tenantId -> { socket, status, qr, retryCount, connectingStartedAt }
const sessions = new Map();

const MAX_RETRY = 10;
const QR_STALE_TIMEOUT_MS = 150000; // 150 seconds - auto-cleanup unscanned QR sessions
const CONNECTING_STALE_TIMEOUT_MS = 120000; // 120 seconds - cleanup sessions stuck in connecting

// Cache WA version at process level — avoids GitHub API call on every session start
let _cachedWAVersion = null;
let _versionCachedAt = 0;
const VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function getWAVersion() {
  const now = Date.now();
  if (_cachedWAVersion && (now - _versionCachedAt) < VERSION_CACHE_TTL_MS) {
    return _cachedWAVersion;
  }
  try {
    const result = await fetchLatestBaileysVersion();
    _cachedWAVersion = result.version;
    _versionCachedAt = now;
    return _cachedWAVersion;
  } catch {
    logger.warn("Using fallback WA version (GitHub unreachable)");
    return [2, 3000, 1035194821];
  }
}

// Validate tenantId to prevent injection attacks (only allow alphanumeric + hyphens)
const TENANT_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function validateTenantId(tenantId) {
  if (!tenantId || typeof tenantId !== "string" || !TENANT_ID_REGEX.test(tenantId)) {
    throw new Error("Invalid tenant ID format");
  }
}

async function startSession(tenantId) {
  validateTenantId(tenantId);

  // Preserve the original connecting-cycle start time across reconnect attempts so the
  // stale-connecting watchdog can fire even when reconnects keep recreating the session.
  let connectingStartedAt = Date.now();
  let retryCount = 0;

  if (sessions.has(tenantId)) {
    const existing = sessions.get(tenantId);
    if (existing.status === "connected") {
      return { status: "connected", message: "Session already connected" };
    }
    if (existing.status === "connecting" || existing.status === "qr") {
      return { status: existing.status, qr: existing.qr };
    }
    // Carry over the cycle start time and retry count when this is an automatic reconnect
    if (existing.status === "reconnecting") {
      if (existing.connectingStartedAt) {
        connectingStartedAt = existing.connectingStartedAt;
      }
      retryCount = existing.retryCount || 0;
    }
    // Close old socket without deleting auth data (important for reconnect after pairing)
    try {
      if (existing.socket) {
        existing.socket.end();
      }
    } catch {
      // Ignore socket close errors
    }
    sessions.delete(tenantId);
  }

  const sessionInfo = {
    socket: null,
    status: "connecting",
    qr: null,
    retryCount,
    qrCreatedAt: null,
    connectingStartedAt,
    device: null,
  };
  sessions.set(tenantId, sessionInfo);

  try {
    // Use PostgreSQL-backed auth state instead of file-based
    const { state, saveCreds } = await usePgAuthState(tenantId);

    const version = await getWAVersion();

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      logger: baileysLogger,
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
      defaultQueryTimeoutMs: 60000,
      browser: Browsers.macOS("Desktop"),
      keepAliveIntervalMs: 30000,
    });

    sessionInfo.socket = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sessionInfo.qr = qr;
        sessionInfo.status = "qr";
        sessionInfo.qrCreatedAt = Date.now();
        // QR was produced — clear the connecting watchdog timer. From here the QR-stale
        // watchdog (qrCreatedAt) governs cleanup, and any brief connecting blip during
        // pairing after the user scans must not be killed by the connecting watchdog.
        sessionInfo.connectingStartedAt = null;
        updateSessionStatus(tenantId, "qr");
        logger.debug({ tenant: tenantId }, "QR code generated");
      }

      if (connection === "open") {
        sessionInfo.status = "connected";
        sessionInfo.qr = null;
        sessionInfo.qrCreatedAt = null;
        sessionInfo.retryCount = 0;

        // Extract device info from socket
        const me = socket.user;
        if (me) {
          const phoneNumber = me.id?.split(":")[0] || me.id?.split("@")[0] || "";
          sessionInfo.device = {
            phone: phoneNumber,
            name: me.name || me.verifiedName || me.notify || "",
            platform: socket.authState?.creds?.platform || "unknown",
            connectedAt: new Date().toISOString(),
          };
        }

        // Update session status in DB
        updateSessionStatus(tenantId, "connected", sessionInfo.device);
        logger.info({ tenant: tenantId, device: sessionInfo.device }, "WhatsApp connected");
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const error = lastDisconnect?.error;
        const errorMsg = error?.message || "Unknown error";

        // Codes that must NEVER trigger reconnect — retrying makes the situation worse
        // 401 = loggedOut (user logged out from phone)
        // 403 = forbidden (account banned by WhatsApp)
        // 500 = badSession (corrupted session, reconnecting won't help)
        const isFatalDisconnect =
          statusCode === DisconnectReason.loggedOut ||   // 401
          statusCode === DisconnectReason.forbidden ||   // 403 — BANNED
          statusCode === DisconnectReason.badSession;    // 500

        const shouldReconnect = !isFatalDisconnect && !sessionInfo.intentionallyClosed;

        // Only log unexpected disconnects (not loggedOut which is intentional, not 515 which is normal restart)
        if (statusCode !== DisconnectReason.loggedOut && statusCode !== 515) {
          logger.warn(
            { tenant: tenantId, statusCode, error: errorMsg, stack: error?.stack },
            "Connection closed"
          );
        }

        // 515 = stream restart after pairing — reconnect immediately, don't count as retry
        const isPairingRestart = statusCode === 515;

        if (shouldReconnect && (isPairingRestart || sessionInfo.retryCount < MAX_RETRY)) {
          if (!isPairingRestart) {
            sessionInfo.retryCount++;
          }
          sessionInfo.status = "reconnecting";
          updateSessionStatus(tenantId, "reconnecting");
          // Wait long enough that the debounced post-pairing creds save (250ms) has
          // committed to PostgreSQL before the new socket re-reads them. Reading stale
          // creds on a 515 pairing restart causes "scanned but never connects".
          // Exponential backoff: 3s, 6s, 12s, ... capped at 60s. Pairing restart always 3s.
          const delay = isPairingRestart
            ? 3000
            : Math.min(60000, 3000 * Math.pow(2, sessionInfo.retryCount - 1));
          logger.info(
            { tenant: tenantId, retry: sessionInfo.retryCount, isPairingRestart },
            "Reconnecting..."
          );
          setTimeout(() => {
            startSession(tenantId).catch((err) => {
              logger.error({ tenant: tenantId, err: err.message }, "Reconnection failed");
              sessionInfo.status = "disconnected";
              updateSessionStatus(tenantId, "disconnected");
            });
          }, delay);
        } else {
          // Fatal disconnect or max retries reached
          const isBanned = statusCode === DisconnectReason.forbidden;
          const finalStatus = isBanned ? "banned" : "disconnected";

          sessionInfo.status = finalStatus;
          updateSessionStatus(tenantId, finalStatus);

          if (isBanned) {
            logger.warn({ tenant: tenantId }, "Account banned by WhatsApp — cleaning up session");
          }

          // Clean up auth data for fatal disconnects (ban, logout, bad session)
          if (isFatalDisconnect) {
            deleteAuthData(tenantId).catch((err) => {
              logger.error({ tenant: tenantId, err: err.message }, "Failed to cleanup auth data");
            });
            sessions.delete(tenantId);
            if (statusCode === DisconnectReason.loggedOut) {
              logger.info({ tenant: tenantId }, "Session logged out and cleaned");
            }
          }
        }
      }
    });

    return { status: "connecting", message: "Session starting, scan QR code" };
  } catch (err) {
    logger.error({ tenant: tenantId, err: err.message }, "Failed to start session");
    sessions.delete(tenantId);
    throw err;
  }
}

async function stopSession(tenantId) {
  const session = sessions.get(tenantId);
  if (!session) {
    return { status: "not_found", message: "No active session" };
  }

  // Mark as intentionally closed to prevent auto-reconnection loop
  session.intentionallyClosed = true;

  // Only call logout if session was actually connected (avoid errors on QR/connecting sessions)
  try {
    if (session.socket && session.status === "connected") {
      await session.socket.logout();
    }
  } catch {
    // Ignore logout errors
  }

  try {
    if (session.socket) {
      session.socket.end();
    }
  } catch {
    // Ignore end errors
  }

  // Delete auth data from PostgreSQL
  try {
    await deleteAuthData(tenantId);
  } catch (err) {
    logger.error({ tenant: tenantId, err: err.message }, "Failed to delete auth data");
  }

  sessions.delete(tenantId);

  return { status: "disconnected", message: "Session stopped and cleaned up" };
}

function getSession(tenantId) {
  return sessions.get(tenantId) || null;
}

async function getStatus(tenantId) {
  try {
    validateTenantId(tenantId);
  } catch {
    return { status: "not_found", message: "Invalid tenant ID format" };
  }

  const session = sessions.get(tenantId);
  if (!session) {
    // Check if there's stored auth data in the database
    const exists = await hasAuthData(tenantId);
    if (exists) {
      return { status: "inactive", message: "Session exists but not started" };
    }
    return { status: "not_found", message: "No session found" };
  }
  return {
    status: session.status,
    qr: session.qr || null,
    device: session.device || null,
  };
}

function listSessions() {
  const result = [];
  for (const [tenantId, session] of sessions) {
    result.push({
      tenantId,
      status: session.status,
    });
  }
  return result;
}

async function sendMessage(tenantId, phone, message, options = {}) {
  let session = sessions.get(tenantId);
  let effectiveTenantId = tenantId;

  // If tenant's own session isn't connected, fall back to superadmin session.
  if ((!session || session.status !== "connected" || !session.socket) && tenantId !== "superadmin") {
    const superadminSession = sessions.get("superadmin");
    if (superadminSession && superadminSession.status === "connected" && superadminSession.socket) {
      logger.warn(
        { tenant: tenantId, fallback: "superadmin" },
        "Tenant WA session not connected, falling back to superadmin"
      );
      session = superadminSession;
      effectiveTenantId = "superadmin";
    }
  }

  if (!session || session.status !== "connected" || !session.socket) {
    throw new Error(`WhatsApp session not connected for tenant ${tenantId}`);
  }

  // Enforce daily limit against the effective (actual) sending session
  if (!options._skipLimitCheck) {
    const todayCount = await getTodaySendCount(effectiveTenantId);
    if (todayCount >= BROADCAST_CONFIG.DAILY_LIMIT_PER_TENANT) {
      throw new Error(`Daily send limit (${BROADCAST_CONFIG.DAILY_LIMIT_PER_TENANT}) reached for tenant ${effectiveTenantId}`);
    }
  }

  // Normalize phone number to WhatsApp JID
  const jid = normalizeJid(phone);

  const messageContent = {};

  if (options.image) validateMediaUrl(options.image);
  if (options.document) validateMediaUrl(options.document);

  if (options.image) {
    messageContent.image = { url: options.image };
    messageContent.caption = message;
  } else if (options.document) {
    messageContent.document = { url: options.document };
    messageContent.fileName = options.fileName || "document";
    messageContent.caption = message;
  } else {
    messageContent.text = message;
  }

  // Simulate typing presence (anti-ban: looks like human interaction)
  if (options.simulateTyping !== false) {
    try {
      await session.socket.presenceSubscribe(jid);
      await sleep(300);
      await session.socket.sendPresenceUpdate("composing", jid);
      // Typing duration proportional to message length (min 1s, max 3s)
      const typingMs = Math.min(3000, Math.max(1000, message.length * 30));
      await sleep(typingMs);
      await session.socket.sendPresenceUpdate("paused", jid);
      await sleep(200);
    } catch {
      // Presence errors are non-fatal, continue sending
    }
  }

  const result = await session.socket.sendMessage(jid, messageContent);

  // Increment daily send count for single messages (broadcast handles its own counting)
  if (!options._skipLimitCheck) {
    await incrementSendCount(effectiveTenantId);
  }

  return {
    id: result?.key?.id || null,
    jid,
    status: "sent",
    timestamp: Date.now(),
  };
}

// ─── Anti-Ban Broadcast Configuration (per-tenant) ───
const BROADCAST_CONFIG = {
  BATCH_SIZE: 10,                 // Messages per batch
  MIN_DELAY_MS: 3000,             // Min delay between messages (3s)
  MAX_DELAY_MS: 7000,             // Max delay between messages (7s)
  BATCH_PAUSE_MIN_MS: 15000,      // Min pause between batches (15s)
  BATCH_PAUSE_MAX_MS: 30000,      // Max pause between batches (30s)
  DAILY_LIMIT_PER_TENANT: 500,    // Max messages per tenant per day
  MAX_CONCURRENT_SENDERS: 3,      // Max tenants sending simultaneously (IP reputation)
};

// ─── Global concurrent send semaphore ───
// Prevents too many tenants blasting messages at the same time from the same IP.
// If tenant A (spam) triggers IP-level WA throttling, it could affect tenants B & C.
// Limiting concurrent senders reduces aggregate throughput from this IP.
let _activeSenders = 0;

async function acquireSendSlot() {
  while (_activeSenders >= BROADCAST_CONFIG.MAX_CONCURRENT_SENDERS) {
    await sleep(2000);
  }
  _activeSenders++;
}

function releaseSendSlot() {
  if (_activeSenders > 0) _activeSenders--;
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function sendBroadcast(tenantId, phones, message, options = {}) {
  // Check daily limit
  const todayCount = await getTodaySendCount(tenantId);
  const remaining = BROADCAST_CONFIG.DAILY_LIMIT_PER_TENANT - todayCount;
  await acquireSendSlot();

  const results = { success: 0, failed: 0, pending: 0, pendingPhones: [], details: [] };

  if (remaining <= 0) {
    // All phones are pending for tomorrow
    results.pending = phones.length;
    results.pendingPhones = phones;
    logger.info(
      { tenant: tenantId, pending: phones.length },
      "Daily limit reached, all phones queued for tomorrow"
    );
    releaseSendSlot();
    return results;
  }

  // Split into today's batch and pending
  const todayPhones = phones.slice(0, remaining);
  const pendingPhones = phones.slice(remaining);

  if (pendingPhones.length > 0) {
    results.pending = pendingPhones.length;
    results.pendingPhones = pendingPhones;
    logger.info(
      { tenant: tenantId, today: todayPhones.length, pending: pendingPhones.length },
      "Broadcast split: partial today, rest queued for tomorrow"
    );
  }

  // Shuffle today's phones to avoid sequential patterns (anti-ban) using Fisher-Yates
  const shuffled = fisherYatesShuffle([...todayPhones]);

  logger.info(
    { tenant: tenantId, total: shuffled.length },
    "Broadcast started"
  );

  for (let i = 0; i < shuffled.length; i++) {
    const phone = shuffled[i];
    const batchIndex = Math.floor(i / BROADCAST_CONFIG.BATCH_SIZE);
    const posInBatch = i % BROADCAST_CONFIG.BATCH_SIZE;

    try {
      const result = await sendMessage(tenantId, phone, message, {
        ...options,
        simulateTyping: true,
        _skipLimitCheck: true,
      });
      results.success++;
      results.details.push({ phone, ...result });
      await incrementSendCount(tenantId);
    } catch (err) {
      results.failed++;
      results.details.push({ phone, status: "failed", error: err.message });
    }

    // Don't delay after the last message
    if (i < shuffled.length - 1) {
      if (posInBatch === BROADCAST_CONFIG.BATCH_SIZE - 1) {
        // End of batch: longer pause
        const batchPause = randomDelay(
          BROADCAST_CONFIG.BATCH_PAUSE_MIN_MS,
          BROADCAST_CONFIG.BATCH_PAUSE_MAX_MS
        );
        logger.debug(
          { tenant: tenantId, batch: batchIndex + 1, sent: i + 1, total: shuffled.length },
          "Batch paused"
        );
        await sleep(batchPause);
      } else {
        // Within batch: random delay between messages
        const msgDelay = randomDelay(
          BROADCAST_CONFIG.MIN_DELAY_MS,
          BROADCAST_CONFIG.MAX_DELAY_MS
        );
        await sleep(msgDelay);
      }
    }
  }

  logger.info(
    { tenant: tenantId, success: results.success, failed: results.failed, pending: results.pending },
    "Broadcast complete"
  );

  releaseSendSlot();
  return results;
}

// Send reminders with anti-ban protection (each phone has a unique message)
// Enforces daily limits, batch pauses, and typing simulation just like sendBroadcast.
async function sendReminderBroadcast(tenantId, phones, phoneMessageMap, phoneCtaMap = new Map()) {
  // Check daily limit
  const todayCount = await getTodaySendCount(tenantId);
  const remaining = BROADCAST_CONFIG.DAILY_LIMIT_PER_TENANT - todayCount;
  await acquireSendSlot();

  const results = { success: 0, failed: 0, pending: 0, pendingPhones: [], details: [] };

  if (remaining <= 0) {
    results.pending = phones.length;
    results.pendingPhones = phones;
    logger.info(
      { tenant: tenantId, pending: phones.length },
      "Daily limit reached for reminders, all queued"
    );
    releaseSendSlot();
    return results;
  }

  // Split into today's batch and pending
  const todayPhones = phones.slice(0, remaining);
  const pendingPhones = phones.slice(remaining);

  if (pendingPhones.length > 0) {
    results.pending = pendingPhones.length;
    results.pendingPhones = pendingPhones;
  }

  // Shuffle for anti-ban
  const shuffled = fisherYatesShuffle([...todayPhones]);

  logger.info(
    { tenant: tenantId, total: shuffled.length, type: "reminder" },
    "Reminder broadcast started"
  );

  for (let i = 0; i < shuffled.length; i++) {
    const phone = shuffled[i];
    const message = phoneMessageMap.get(phone);
    const posInBatch = i % BROADCAST_CONFIG.BATCH_SIZE;

    if (!message) {
      results.failed++;
      results.details.push({ phone, status: "failed", error: "Message not found for phone" });
      continue;
    }

    try {
      const ctaButton = phoneCtaMap.get(phone) || null;
      const result = await sendMessage(tenantId, phone, message, {
        simulateTyping: true,
        _skipLimitCheck: true,
        ctaButton,
      });
      results.success++;
      results.details.push({ phone, ...result });
      await incrementSendCount(tenantId);
    } catch (err) {
      results.failed++;
      results.details.push({ phone, status: "failed", error: err.message });
    }

    // Anti-ban delays (same as sendBroadcast)
    if (i < shuffled.length - 1) {
      if (posInBatch === BROADCAST_CONFIG.BATCH_SIZE - 1) {
        const batchPause = randomDelay(
          BROADCAST_CONFIG.BATCH_PAUSE_MIN_MS,
          BROADCAST_CONFIG.BATCH_PAUSE_MAX_MS
        );
        await sleep(batchPause);
      } else {
        const msgDelay = randomDelay(
          BROADCAST_CONFIG.MIN_DELAY_MS,
          BROADCAST_CONFIG.MAX_DELAY_MS
        );
        await sleep(msgDelay);
      }
    }
  }

  logger.info(
    { tenant: tenantId, success: results.success, failed: results.failed, pending: results.pending },
    "Reminder broadcast complete"
  );

  releaseSendSlot();
  return results;
}

// ─── Database-backed daily send counter ───

/**
 * Get today's send count for a tenant from PostgreSQL.
 */
async function getTodaySendCount(tenantId) {
  const pool = getPool();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const result = await pool.query(
    "SELECT send_count FROM wa_daily_counts WHERE tenant_id = $1 AND count_date = $2",
    [tenantId, today]
  );

  if (result.rows.length === 0) {
    return 0;
  }
  return result.rows[0].send_count;
}

/**
 * Increment daily send count for a tenant in PostgreSQL (atomic upsert).
 */
async function incrementSendCount(tenantId, amount = 1) {
  const pool = getPool();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  await pool.query(
    `INSERT INTO wa_daily_counts (tenant_id, count_date, send_count)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, count_date)
     DO UPDATE SET send_count = wa_daily_counts.send_count + $3`,
    [tenantId, today, amount]
  );
}

/**
 * Update session status in the database.
 */
async function updateSessionStatus(tenantId, status, device = null) {
  try {
    const pool = getPool();

    if (device) {
      await pool.query(
        `INSERT INTO wa_session_status (tenant_id, status, device_phone, device_name, device_platform, connected_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
         ON CONFLICT (tenant_id)
         DO UPDATE SET status = $2, device_phone = $3, device_name = $4, device_platform = $5, connected_at = NOW(), updated_at = NOW()`,
        [tenantId, status, device.phone || null, device.name || null, device.platform || null]
      );
    } else {
      await pool.query(
        `INSERT INTO wa_session_status (tenant_id, status, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (tenant_id)
         DO UPDATE SET status = $2, updated_at = NOW()`,
        [tenantId, status]
      );
    }
  } catch (err) {
    logger.error({ tenant: tenantId, err: err.message }, "Failed to update session status in DB");
  }
}

function validateMediaUrl(url) {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Only http and https URLs are allowed for media");
    }
  } catch (err) {
    if (err.message.includes("Only http")) throw err;
    throw new Error("Invalid media URL format");
  }
}

function normalizeJid(phone) {
  if (!phone || typeof phone !== "string") {
    throw new Error("Phone number is required and must be a string");
  }

  // Remove non-digit characters
  let cleaned = phone.replace(/\D/g, "");

  if (cleaned.length < 7) {
    throw new Error(`Invalid phone number: ${phone} (too short)`);
  }

  // Handle Indonesian numbers: 08xx -> 628xx
  if (cleaned.startsWith("0")) {
    cleaned = "62" + cleaned.slice(1);
  }

  // Only prepend 62 if number is short (local without country code)
  // Numbers already starting with country code (e.g. 60xxx, 1xxx) should not be prefixed
  if (cleaned.length <= 10 && !cleaned.startsWith("62")) {
    cleaned = "62" + cleaned;
  }

  return cleaned + "@s.whatsapp.net";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Fisher-Yates shuffle for uniformly random permutation (anti-ban)
function fisherYatesShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Restore sessions from database on startup
async function restoreSessions() {
  try {
    const tenantIds = await getAllTenantIds();

    logger.info({ count: tenantIds.length }, "Restoring saved sessions from PostgreSQL");

    for (const tenantId of tenantIds) {
      try {
        await startSession(tenantId);
        logger.debug({ tenant: tenantId }, "Session restored");
      } catch (err) {
        logger.error(
          { tenant: tenantId, err: err.message },
          "Failed to restore session"
        );
      }
      // Delay between session restorations to avoid triggering WA anti-ban
      if (tenantIds.length > 1) {
        await sleep(3000);
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, "Failed to restore sessions from database");
  }
}

// Periodic cleanup of stale sessions (per-tenant)
// - QR sessions not scanned within QR_STALE_TIMEOUT_MS are stopped
// - Sessions stuck in "connecting" longer than CONNECTING_STALE_TIMEOUT_MS are stopped
//   (this handles the case where saved credentials are expired/invalid and Baileys can't reconnect)
let staleCleanupRunning = false;
const staleCleanupInterval = setInterval(async () => {
  if (staleCleanupRunning) return; // Prevent concurrent cleanup runs
  staleCleanupRunning = true;
  try {
    const now = Date.now();
    for (const [tenantId, session] of sessions) {
      if (
        session.status === "qr" &&
        session.qrCreatedAt &&
        now - session.qrCreatedAt > QR_STALE_TIMEOUT_MS
      ) {
        logger.info(
          { tenant: tenantId, staleSec: Math.round((now - session.qrCreatedAt) / 1000) },
          "Cleaning up stale QR session (not scanned)"
        );
        try {
          await stopSession(tenantId);
        } catch (err) {
          logger.error({ tenant: tenantId, err: err.message }, "Failed to cleanup stale QR session");
        }
      } else if (
        (session.status === "connecting" || session.status === "reconnecting") &&
        session.connectingStartedAt &&
        now - session.connectingStartedAt > CONNECTING_STALE_TIMEOUT_MS
      ) {
        // Session has been connecting/reconnecting too long without producing a QR — saved
        // credentials are likely expired and Baileys can't pair. Stop the session (which clears
        // the bad auth data) so the user can start fresh and get a new QR.
        logger.info(
          { tenant: tenantId, status: session.status, staleSec: Math.round((now - session.connectingStartedAt) / 1000) },
          "Cleaning up stale connecting/reconnecting session (no QR produced, credentials may be expired)"
        );
        try {
          await stopSession(tenantId);
        } catch (err) {
          logger.error({ tenant: tenantId, err: err.message }, "Failed to cleanup stale connecting session");
        }
      }
    }
  } finally {
    staleCleanupRunning = false;
  }
}, 15000); // Check every 15 seconds

// Gracefully close all active Baileys sockets (called on SIGTERM/SIGINT)
async function gracefulShutdown() {
  clearInterval(staleCleanupInterval);
  const tenantIds = [...sessions.keys()];
  logger.info({ count: tenantIds.length }, "Gracefully closing all sessions");
  for (const tenantId of tenantIds) {
    try {
      const session = sessions.get(tenantId);
      if (session?.socket) {
        session.socket.end();
      }
      sessions.delete(tenantId);
    } catch (err) {
      logger.error({ tenant: tenantId, err: err.message }, "Error closing session during shutdown");
    }
  }
}

module.exports = {
  startSession,
  stopSession,
  getSession,
  getStatus,
  listSessions,
  sendMessage,
  sendBroadcast,
  sendReminderBroadcast,
  restoreSessions,
  gracefulShutdown,
};