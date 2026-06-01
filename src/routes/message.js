const express = require("express");
const sessionManager = require("../services/session-manager");

const router = express.Router();

// Send a single message
router.post("/send", async (req, res) => {
  try {
    const { tenantId, message, image, document, fileName } = req.body;
    const phone = req.body.phone != null ? String(req.body.phone) : undefined;

    if (!tenantId || !phone || !message) {
      return res
        .status(400)
        .json({ error: "tenantId, phone, and message are required" });
    }

    const result = await sessionManager.sendMessage(tenantId, phone, message, {
      image,
      document,
      fileName,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send broadcast to multiple numbers
router.post("/broadcast", async (req, res) => {
  try {
    const { tenantId, phones, message, image, document, fileName } = req.body;

    if (!tenantId || !phones || !Array.isArray(phones) || !message) {
      return res
        .status(400)
        .json({ error: "tenantId, phones (array), and message are required" });
    }

    // Coerce all phone entries to strings (client may send numbers)
    const phoneStrings = phones.map((p) => (p != null ? String(p) : "")).filter(Boolean);

    if (phoneStrings.length === 0) {
      return res.status(400).json({ error: "phones array cannot be empty" });
    }

    if (phoneStrings.length > 5000) {
      return res.status(400).json({ error: "phones array cannot exceed 5000 numbers" });
    }

    const results = await sessionManager.sendBroadcast(
      tenantId,
      phoneStrings,
      message,
      { image, document, fileName }
    );

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send invoice reminder (formatted for ISP billing)
// Uses sendBroadcast internally for anti-ban protection and daily limit enforcement
router.post("/reminder", async (req, res) => {
  try {
    const { tenantId, reminders } = req.body;

    if (!tenantId || !reminders || !Array.isArray(reminders)) {
      return res
        .status(400)
        .json({ error: "tenantId and reminders (array) are required" });
    }

    // Pre-process: format messages and collect valid phones
    const validPhones = [];
    const phoneMessageMap = new Map();
    const phoneCtaMap = new Map();
    const skipped = [];

    for (const reminder of reminders) {
      const { phone, customerName, invoiceNumber, amount, dueDate, message, ctaButton } =
        reminder;

      if (!phone || !message) {
        skipped.push({
          phone: phone || "unknown",
          status: "failed",
          error: "phone and message are required",
        });
        continue;
      }

      // Coerce phone to string (client may send numbers)
      const phoneStr = String(phone);

      // Build formatted message with template variables replaced
      const formattedMessage = message
        .replace(/\{nama\}/gi, customerName || "")
        .replace(/\{invoice\}/gi, invoiceNumber || "")
        .replace(/\{jumlah\}/gi, formatRupiah(amount || 0))
        .replace(/\{jatuh_tempo\}/gi, dueDate || "");

      validPhones.push(phoneStr);
      phoneMessageMap.set(phoneStr, formattedMessage);

      // Attach CTA button (e.g. "Bayar Online" → payment gateway URL)
      if (ctaButton && ctaButton.url) {
        phoneCtaMap.set(phoneStr, {
          text: ctaButton.text || "Bayar Online",
          url: ctaButton.url,
        });
      }
    }

    // Deduplicate: phoneMessageMap already keeps last message per phone,
    // but validPhones may contain duplicates — use only unique keys from Map
    const uniquePhones = [...new Set(validPhones)];

    if (uniquePhones.length === 0) {
      return res.json({
        success: 0,
        failed: skipped.length,
        pending: 0,
        pendingPhones: [],
        details: skipped,
      });
    }

    // Use sendBroadcast for anti-ban protection (daily limits, batch pauses, shuffle)
    // Since each reminder has a unique message, we send individually but with broadcast-style throttling
    const results = await sessionManager.sendReminderBroadcast(
      tenantId,
      uniquePhones,
      phoneMessageMap,
      phoneCtaMap
    );

    // Merge skipped items into results
    results.failed += skipped.length;
    results.details = [...skipped, ...results.details];

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatRupiah(amount) {
  return "Rp " + Number(amount).toLocaleString("id-ID");
}

module.exports = router;
