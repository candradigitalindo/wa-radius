const crypto = require("crypto");
const config = require("../config");

function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }

  const token = authHeader.slice(7);
  if (!config.apiSecret) {
    return res.status(500).json({ error: "API secret not configured" });
  }

  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(config.apiSecret);
  if (tokenBuf.length !== secretBuf.length || !crypto.timingSafeEqual(tokenBuf, secretBuf)) {
    return res.status(401).json({ error: "Invalid API secret" });
  }

  next();
}

module.exports = authMiddleware;
