const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const config = require("../config");

const logger = pino({ level: config.logLevel });

// In-memory store of active sessions: tenantId -> { socket, status, qr, retryCount }
const sessions = new Map();

const MAX_RETRY = 3;
const QR_STALE_TIMEOUT_MS = 150000; // 150 seconds - auto-cleanup unscanned QR sessions

// Validate tenantId to prevent path traversal attacks (only allow alphanumeric + hyphens)
const TENANT_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function validateTenantId(tenantId) {
  if (!tenantId || typeof tenantId !== "string" || !TENANT_ID_REGEX.test(tenantId)) {
    throw new Error("Invalid tenant ID format");
  }
}

function getSessionDir(tenantId) {
  validateTenantId(tenantId);
  return path.join(config.sessionDir, tenantId);
}

async function startSession(tenantId) {
  if (sessions.has(tenantId)) {
    const existing = sessions.get(tenantId);
    if (existing.status === "connected") {
      return { status: "connected", message: "Session already connected" };
    }
    if (existing.status === "connecting" || existing.status === "qr") {
      return { status: existing.status, qr: existing.qr };
    }
    // Close old socket without deleting auth files (important for reconnect after pairing)
    try {
      if (existing.socket) {
        existing.socket.end();
      }
    } catch {
      // Ignore socket close errors
    }
    sessions.delete(tenantId);
  }

  const sessionDir = getSessionDir(tenantId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionInfo = {
    socket: null,
    status: "connecting",
    qr: null,
    retryCount: 0,
    qrCreatedAt: null,
    device: null,
  };
  sessions.set(tenantId, sessionInfo);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // Cache version to avoid slow GitHub API call on every session start
    let version;
    try {
      const result = await fetchLatestBaileysVersion();
      version = result.version;
    } catch {
      // Fallback version if GitHub unreachable
      version = [2, 3000, 1015901307];
      logger.warn({ tenant: tenantId }, "Using fallback WA version (GitHub unreachable)");
    }

    const socket = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger: logger.child({ tenant: tenantId }),
      printQRInTerminal: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      connectTimeoutMs: 60000,
      qrTimeout: 60000,
      defaultQueryTimeoutMs: 60000,
      browser: ["ISP Radius", "Chrome", "120.0.0"],
    });

    sessionInfo.socket = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sessionInfo.qr = qr;
        sessionInfo.status = "qr";
        sessionInfo.qrCreatedAt = Date.now();
        logger.info({ tenant: tenantId }, "QR code generated");
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
        logger.info({ tenant: tenantId, device: sessionInfo.device }, "WhatsApp connected");
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut && !sessionInfo.intentionallyClosed;

        logger.warn(
          { tenant: tenantId, statusCode },
          "Connection closed"
        );

        // 515 = stream restart after pairing — reconnect immediately, don't count as retry
        const isPairingRestart = statusCode === 515;

        if (shouldReconnect && (isPairingRestart || sessionInfo.retryCount < MAX_RETRY)) {
          if (!isPairingRestart) {
            sessionInfo.retryCount++;
          }
          sessionInfo.status = "reconnecting";
          const delay = isPairingRestart ? 1000 : 3000;
          logger.info(
            { tenant: tenantId, retry: sessionInfo.retryCount, isPairingRestart },
            "Reconnecting..."
          );
          setTimeout(() => {
            startSession(tenantId).catch((err) => {
              logger.error({ tenant: tenantId, err: err.message }, "Reconnection failed");
              sessionInfo.status = "disconnected";
            });
          }, delay);
        } else {
          sessionInfo.status = "disconnected";
          if (statusCode === DisconnectReason.loggedOut) {
            // Clean up session files if logged out
            fs.rmSync(sessionDir, { recursive: true, force: true });
            sessions.delete(tenantId);
            logger.info({ tenant: tenantId }, "Session logged out and cleaned");
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

  const sessionDir = getSessionDir(tenantId);
  fs.rmSync(sessionDir, { recursive: true, force: true });
  sessions.delete(tenantId);

  return { status: "disconnected", message: "Session stopped and cleaned up" };
}

function getSession(tenantId) {
  return sessions.get(tenantId) || null;
}

function getStatus(tenantId) {
  try {
    validateTenantId(tenantId);
  } catch {
    return { status: "not_found", message: "Invalid tenant ID format" };
  }

  const session = sessions.get(tenantId);
  if (!session) {
    // Check if there's a stored session directory
    const sessionDir = getSessionDir(tenantId);
    if (fs.existsSync(sessionDir)) {
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
  const session = sessions.get(tenantId);
  if (!session || session.status !== "connected" || !session.socket) {
    throw new Error(`WhatsApp session not connected for tenant ${tenantId}`);
  }

  // Enforce daily limit for all sends (including single messages)
  if (!options._skipLimitCheck) {
    const todayCount = getTodaySendCount(tenantId);
    if (todayCount >= BROADCAST_CONFIG.DAILY_LIMIT_PER_TENANT) {
      throw new Error(`Daily send limit (${BROADCAST_CONFIG.DAILY_LIMIT_PER_TENANT}) reached for tenant ${tenantId}`);
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
    incrementSendCount(tenantId);
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
};

// Per-tenant daily send counter: tenantId -> { count, date }
const dailySendCount = new Map();
const DAILY_COUNT_FILE = path.join(config.sessionDir, ".daily-counts.json");

let _saveCountsTimer = null;

function loadDailyCounts() {
  try {
    if (fs.existsSync(DAILY_COUNT_FILE)) {
      const data = JSON.parse(fs.readFileSync(DAILY_COUNT_FILE, "utf-8"));
      const today = new Date().toISOString().slice(0, 10);
      for (const [tenantId, record] of Object.entries(data)) {
        if (record && record.date === today) {
          dailySendCount.set(tenantId, record);
        }
      }
      logger.info({ entries: dailySendCount.size }, "Loaded daily send counts from disk");
    }
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to load daily send counts");
  }
}

function saveDailyCounts() {
  try {
    const data = {};
    for (const [tenantId, record] of dailySendCount) {
      data[tenantId] = record;
    }
    fs.mkdirSync(path.dirname(DAILY_COUNT_FILE), { recursive: true });
    fs.writeFileSync(DAILY_COUNT_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    logger.warn({ err: err.message }, "Failed to save daily send counts");
  }
}

function scheduleSaveCounts() {
  if (_saveCountsTimer) return;
  _saveCountsTimer = setTimeout(() => {
    _saveCountsTimer = null;
    saveDailyCounts();
  }, 5000);
}

function getTodaySendCount(tenantId) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const record = dailySendCount.get(tenantId);
  if (!record || record.date !== today) {
    dailySendCount.set(tenantId, { count: 0, date: today });
    return 0;
  }
  return record.count;
}

function incrementSendCount(tenantId, amount = 1) {
  const today = new Date().toISOString().slice(0, 10);
  const record = dailySendCount.get(tenantId);
  if (!record || record.date !== today) {
    dailySendCount.set(tenantId, { count: amount, date: today });
  } else {
    record.count += amount;
  }
  scheduleSaveCounts();
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function sendBroadcast(tenantId, phones, message, options = {}) {
  // Check daily limit
  const todayCount = getTodaySendCount(tenantId);
  const remaining = BROADCAST_CONFIG.DAILY_LIMIT_PER_TENANT - todayCount;

  const results = { success: 0, failed: 0, pending: 0, pendingPhones: [], details: [] };

  if (remaining <= 0) {
    // All phones are pending for tomorrow
    results.pending = phones.length;
    results.pendingPhones = phones;
    logger.info(
      { tenant: tenantId, pending: phones.length },
      "Daily limit reached, all phones queued for tomorrow"
    );
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
    { tenant: tenantId, total: shuffled.length, batchSize: BROADCAST_CONFIG.BATCH_SIZE },
    "Starting anti-ban broadcast"
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
      incrementSendCount(tenantId);
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
        logger.info(
          { tenant: tenantId, batch: batchIndex + 1, pauseMs: batchPause, sent: i + 1, total: shuffled.length },
          "Batch complete, pausing"
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
    "Broadcast batch complete"
  );

  return results;
}

// Send reminders with anti-ban protection (each phone has a unique message)
// Enforces daily limits, batch pauses, and typing simulation just like sendBroadcast.
async function sendReminderBroadcast(tenantId, phones, phoneMessageMap) {
  // Check daily limit
  const todayCount = getTodaySendCount(tenantId);
  const remaining = BROADCAST_CONFIG.DAILY_LIMIT_PER_TENANT - todayCount;

  const results = { success: 0, failed: 0, pending: 0, pendingPhones: [], details: [] };

  if (remaining <= 0) {
    results.pending = phones.length;
    results.pendingPhones = phones;
    logger.info(
      { tenant: tenantId, pending: phones.length },
      "Daily limit reached for reminders, all queued"
    );
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
    "Starting anti-ban reminder broadcast"
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
      const result = await sendMessage(tenantId, phone, message, {
        simulateTyping: true,
        _skipLimitCheck: true,
      });
      results.success++;
      results.details.push({ phone, ...result });
      incrementSendCount(tenantId);
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

  return results;
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

// Restore sessions from disk on startup
async function restoreSessions() {
  if (!fs.existsSync(config.sessionDir)) {
    fs.mkdirSync(config.sessionDir, { recursive: true });
    return;
  }

  loadDailyCounts();

  const dirs = fs
    .readdirSync(config.sessionDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  logger.info({ count: dirs.length }, "Restoring saved sessions");

  for (const tenantId of dirs) {
    try {
      await startSession(tenantId);
      logger.info({ tenant: tenantId }, "Session restored");
    } catch (err) {
      logger.error(
        { tenant: tenantId, err: err.message },
        "Failed to restore session"
      );
    }
    // Delay between session restorations to avoid triggering WA anti-ban
    if (dirs.length > 1) {
      await sleep(3000);
    }
  }
}

// Periodic cleanup of stale QR sessions (per-tenant)
// If a tenant's QR is not scanned within QR_STALE_TIMEOUT_MS, the session is stopped
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
          logger.error({ tenant: tenantId, err: err.message }, "Failed to cleanup stale session");
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
  if (_saveCountsTimer) clearTimeout(_saveCountsTimer);
  saveDailyCounts();
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
