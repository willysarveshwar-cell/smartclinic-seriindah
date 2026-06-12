const db = require("../db");

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}

async function logAuthEvent({
  req,
  eventType,
  status,
  userId = null,
  email = null,
  role = null,
  details = null
}) {
  try {
    await db.queryAsync(
      `INSERT INTO auth_audit_logs
       (event_type, status, user_id, email, role, ip_address, user_agent, details, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        eventType,
        status,
        userId,
        email,
        role,
        getClientIp(req),
        String(req.headers["user-agent"] || "").slice(0, 255),
        details ? JSON.stringify(details) : null
      ]
    );
  } catch (error) {
    if (error && (error.code === "42P01" || /auth_audit_logs/i.test(String(error.message)))) {
      return;
    }
    // Avoid blocking auth flows due to audit persistence issues.
    console.error("Auth audit log error:", error.message);
  }
}

module.exports = {
  logAuthEvent
};
