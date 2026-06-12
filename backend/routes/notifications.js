const express = require("express");
const Joi = require("joi");
const db = require("../db");
const { authenticate, requireRole } = require("../middleware/auth");
const {
  getNotificationSettings,
  updateNotificationSettings,
  processScheduledNotifications
} = require("../services/notificationService");

const router = express.Router();

const settingsSchema = Joi.object({
  email_enabled: Joi.boolean(),
  sms_enabled: Joi.boolean(),
  appointment_confirmation_email: Joi.boolean(),
  appointment_confirmation_sms: Joi.boolean(),
  appointment_reminder_email: Joi.boolean(),
  appointment_reminder_sms: Joi.boolean(),
  queue_updates_enabled: Joi.boolean(),
  missed_appointment_enabled: Joi.boolean(),
  reminder_lead_minutes: Joi.number().integer().min(5).max(10080),
  missed_grace_minutes: Joi.number().integer().min(5).max(1440),
  smtp_server: Joi.string().allow(""),
  smtp_port: Joi.number().integer().min(1).max(65535),
  smtp_username: Joi.string().allow(""),
  sms_provider: Joi.string().allow("")
});

router.get("/settings", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const settings = await getNotificationSettings(db);
    res.json(settings);
  } catch (error) {
    console.error("Notification settings load error:", error.message);
    res.status(500).json({ message: "Failed to load notification settings" });
  }
});

router.put("/settings", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const { error, value } = settingsSchema.validate(req.body, { abortEarly: false, stripUnknown: true });

    if (error) {
      return res.status(400).json({
        message: "Invalid notification settings",
        details: error.details.map((detail) => detail.message)
      });
    }

    const settings = await updateNotificationSettings(db, value);
    res.json({ message: "Notification settings saved", settings });
  } catch (error) {
    console.error("Notification settings save error:", error.message);
    res.status(500).json({ message: "Failed to save notification settings" });
  }
});

router.get("/logs", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await db.queryAsync(
      `SELECT n.id, n.appointment_id, n.event_type, n.channel, n.recipient, n.message, n.sent_status, n.sent_at,
              a.patient_name, d.name AS doctor_name, n.created_at
       FROM notifications n
       LEFT JOIN appointments a ON a.id = n.appointment_id
       LEFT JOIN doctors d ON d.id = a.doctor_id
       ORDER BY n.created_at DESC
       LIMIT ?`,
      [limit]
    );

    res.json(rows);
  } catch (error) {
    console.error("Notification logs load error:", error.message);
    res.status(500).json({ message: "Failed to load notification logs" });
  }
});

router.post("/process", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const summary = await processScheduledNotifications(db);
    res.json({ message: "Notification jobs processed", summary });
  } catch (error) {
    console.error("Notification processing error:", error.message);
    res.status(500).json({ message: "Failed to process notification jobs" });
  }
});

module.exports = router;
