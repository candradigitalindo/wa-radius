const express = require("express");
const qrcode = require("qrcode");
const sessionManager = require("../services/session-manager");

const router = express.Router();

// Start a new WhatsApp session for a tenant
router.post("/:tenantId/start", async (req, res) => {
  try {
    const { tenantId } = req.params;
    const result = await sessionManager.startSession(tenantId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session status
router.get("/:tenantId/status", async (req, res) => {
  try {
    const { tenantId } = req.params;
    const status = await sessionManager.getStatus(tenantId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get QR code as base64 image
router.get("/:tenantId/qr", async (req, res) => {
  try {
    const { tenantId } = req.params;
    const status = await sessionManager.getStatus(tenantId);

    if (!status.qr) {
      // Return 200 with current status so caller can detect connected/disconnected
      return res.json({
        qr: null,
        status: status.status,
        message: status.message || null,
      });
    }

    const qrImage = await qrcode.toDataURL(status.qr, {
      margin: 2,
      scale: 4,
      errorCorrectionLevel: 'H'
    });
    res.json({ qr: qrImage, status: status.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disconnect/logout session
router.delete("/:tenantId", async (req, res) => {
  try {
    const { tenantId } = req.params;
    const result = await sessionManager.stopSession(tenantId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all active sessions
router.get("/", (req, res) => {
  try {
    const sessions = sessionManager.listSessions();
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
