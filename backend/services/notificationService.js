const nodemailer = require("nodemailer");

let transporter = null;

const DEFAULT_SETTINGS = {
  id: 1,
  email_enabled: true,
  sms_enabled: false,
  appointment_confirmation_email: true,
  appointment_confirmation_sms: false,
  appointment_reminder_email: true,
  appointment_reminder_sms: false,
  queue_updates_enabled: true,
  missed_appointment_enabled: true,
  reminder_lead_minutes: 1440,
  missed_grace_minutes: 30,
  smtp_server: "",
  smtp_port: 587,
  smtp_username: "",
  sms_provider: "twilio"
};

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendEmailReminder({ to, subject, text }) {
  if (!to) return { sent: false, channel: "email", reason: "No recipient" };

  if (!transporter) {
    console.log(`[Notification:EMAIL] ${to} | ${subject} | ${text}`);
    return { sent: false, channel: "email", reason: "SMTP not configured, logged only" };
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text
  });

  return { sent: true, channel: "email" };
}

async function sendSmsReminder({ to, text }) {
  if (!to) return { sent: false, channel: "sms", reason: "No phone number" };

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM) {
    console.log(`[Notification:SMS] ${to} | ${text}`);
    return { sent: false, channel: "sms", reason: "Twilio not configured, logged only" };
  }

  const twilio = require("twilio");
  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  await client.messages.create({
    body: text,
    from: process.env.TWILIO_FROM,
    to
  });

  return { sent: true, channel: "sms" };
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return fallback;
}

function normalizeInteger(value, fallback) {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapSettingsRow(row = {}) {
  return {
    id: 1,
    email_enabled: normalizeBoolean(row.email_enabled, DEFAULT_SETTINGS.email_enabled),
    sms_enabled: normalizeBoolean(row.sms_enabled, DEFAULT_SETTINGS.sms_enabled),
    appointment_confirmation_email: normalizeBoolean(
      row.appointment_confirmation_email,
      DEFAULT_SETTINGS.appointment_confirmation_email
    ),
    appointment_confirmation_sms: normalizeBoolean(
      row.appointment_confirmation_sms,
      DEFAULT_SETTINGS.appointment_confirmation_sms
    ),
    appointment_reminder_email: normalizeBoolean(
      row.appointment_reminder_email,
      DEFAULT_SETTINGS.appointment_reminder_email
    ),
    appointment_reminder_sms: normalizeBoolean(
      row.appointment_reminder_sms,
      DEFAULT_SETTINGS.appointment_reminder_sms
    ),
    queue_updates_enabled: normalizeBoolean(
      row.queue_updates_enabled,
      DEFAULT_SETTINGS.queue_updates_enabled
    ),
    missed_appointment_enabled: normalizeBoolean(
      row.missed_appointment_enabled,
      DEFAULT_SETTINGS.missed_appointment_enabled
    ),
    reminder_lead_minutes: normalizeInteger(
      row.reminder_lead_minutes,
      DEFAULT_SETTINGS.reminder_lead_minutes
    ),
    missed_grace_minutes: normalizeInteger(
      row.missed_grace_minutes,
      DEFAULT_SETTINGS.missed_grace_minutes
    ),
    smtp_server: row.smtp_server || "",
    smtp_port: normalizeInteger(row.smtp_port, DEFAULT_SETTINGS.smtp_port),
    smtp_username: row.smtp_username || "",
    sms_provider: row.sms_provider || DEFAULT_SETTINGS.sms_provider
  };
}

async function getNotificationSettings(db) {
  const rows = await db.queryAsync(`SELECT * FROM notification_settings WHERE id = 1 LIMIT 1`);

  if (!rows.length) {
    await db.queryAsync(
      `INSERT INTO notification_settings (
        id, email_enabled, sms_enabled, appointment_confirmation_email, appointment_confirmation_sms,
        appointment_reminder_email, appointment_reminder_sms, queue_updates_enabled,
        missed_appointment_enabled, reminder_lead_minutes, missed_grace_minutes,
        smtp_server, smtp_port, smtp_username, sms_provider
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        DEFAULT_SETTINGS.email_enabled ? 1 : 0,
        DEFAULT_SETTINGS.sms_enabled ? 1 : 0,
        DEFAULT_SETTINGS.appointment_confirmation_email ? 1 : 0,
        DEFAULT_SETTINGS.appointment_confirmation_sms ? 1 : 0,
        DEFAULT_SETTINGS.appointment_reminder_email ? 1 : 0,
        DEFAULT_SETTINGS.appointment_reminder_sms ? 1 : 0,
        DEFAULT_SETTINGS.queue_updates_enabled ? 1 : 0,
        DEFAULT_SETTINGS.missed_appointment_enabled ? 1 : 0,
        DEFAULT_SETTINGS.reminder_lead_minutes,
        DEFAULT_SETTINGS.missed_grace_minutes,
        DEFAULT_SETTINGS.smtp_server,
        DEFAULT_SETTINGS.smtp_port,
        DEFAULT_SETTINGS.smtp_username,
        DEFAULT_SETTINGS.sms_provider
      ]
    );

    return { ...DEFAULT_SETTINGS };
  }

  return mapSettingsRow(rows[0]);
}

async function updateNotificationSettings(db, payload = {}) {
  const merged = {
    ...(await getNotificationSettings(db)),
    ...payload
  };

  const normalized = mapSettingsRow(merged);

  await db.queryAsync(
    `UPDATE notification_settings SET
      email_enabled = ?,
      sms_enabled = ?,
      appointment_confirmation_email = ?,
      appointment_confirmation_sms = ?,
      appointment_reminder_email = ?,
      appointment_reminder_sms = ?,
      queue_updates_enabled = ?,
      missed_appointment_enabled = ?,
      reminder_lead_minutes = ?,
      missed_grace_minutes = ?,
      smtp_server = ?,
      smtp_port = ?,
      smtp_username = ?,
      sms_provider = ?
    WHERE id = 1`,
    [
      normalized.email_enabled ? 1 : 0,
      normalized.sms_enabled ? 1 : 0,
      normalized.appointment_confirmation_email ? 1 : 0,
      normalized.appointment_confirmation_sms ? 1 : 0,
      normalized.appointment_reminder_email ? 1 : 0,
      normalized.appointment_reminder_sms ? 1 : 0,
      normalized.queue_updates_enabled ? 1 : 0,
      normalized.missed_appointment_enabled ? 1 : 0,
      normalized.reminder_lead_minutes,
      normalized.missed_grace_minutes,
      normalized.smtp_server,
      normalized.smtp_port,
      normalized.smtp_username,
      normalized.sms_provider
    ]
  );

  return normalized;
}

async function logNotification(
  db,
  { appointmentId = null, eventType = null, channel, recipient = null, message, sentStatus = "logged", details = null }
) {
  await db.queryAsync(
    `INSERT INTO notifications (appointment_id, event_type, channel, recipient, message, sent_status, details, sent_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [appointmentId, eventType, channel, recipient, message, sentStatus, details ? JSON.stringify(details) : null]
  );
}

async function dispatchNotificationChannels(
  db,
  {
    appointmentId = null,
    eventType,
    emailRecipient,
    smsRecipient,
    subject,
    message,
    emailAllowed,
    smsAllowed,
    details = null
  }
) {
  const results = [];

  if (emailAllowed) {
    const emailResult = await sendEmailReminder({ to: emailRecipient, subject, text: message });
    await logNotification(db, {
      appointmentId,
      eventType,
      channel: "email",
      recipient: emailRecipient,
      message,
      sentStatus: emailResult.sent ? "sent" : "logged",
      details: emailResult.reason ? { ...(details || {}), reason: emailResult.reason } : details
    });
    results.push(emailResult);
  } else {
    await logNotification(db, {
      appointmentId,
      eventType,
      channel: "email",
      recipient: emailRecipient,
      message,
      sentStatus: "disabled",
      details
    });
  }

  if (smsAllowed) {
    const smsResult = await sendSmsReminder({ to: smsRecipient, text: message });
    await logNotification(db, {
      appointmentId,
      eventType,
      channel: "sms",
      recipient: smsRecipient,
      message,
      sentStatus: smsResult.sent ? "sent" : "logged",
      details: smsResult.reason ? { ...(details || {}), reason: smsResult.reason } : details
    });
    results.push(smsResult);
  } else {
    await logNotification(db, {
      appointmentId,
      eventType,
      channel: "sms",
      recipient: smsRecipient,
      message,
      sentStatus: "disabled",
      details
    });
  }

  return results;
}

async function notifyAppointmentConfirmation(db, appointment) {
  const settings = await getNotificationSettings(db);
  const message = `Your appointment with Dr. ${appointment.doctor_name} is booked for ${appointment.appointment_date} at ${appointment.appointment_time}.`;
  const subject = "Appointment confirmation";

  return dispatchNotificationChannels(db, {
    appointmentId: appointment.id,
    eventType: "appointment_confirmation",
    emailRecipient: appointment.email,
    smsRecipient: appointment.phone,
    subject,
    message,
    emailAllowed: settings.email_enabled && settings.appointment_confirmation_email,
    smsAllowed: settings.sms_enabled && settings.appointment_confirmation_sms,
    details: { doctor_id: appointment.doctor_id }
  });
}

async function notifyAppointmentReminder(db, appointment) {
  const settings = await getNotificationSettings(db);
  const message = `Reminder: you have an appointment with Dr. ${appointment.doctor_name} on ${appointment.appointment_date} at ${appointment.appointment_time}.`;

  return dispatchNotificationChannels(db, {
    appointmentId: appointment.id,
    eventType: "appointment_reminder",
    emailRecipient: appointment.email,
    smsRecipient: appointment.phone,
    subject: "Appointment reminder",
    message,
    emailAllowed: settings.email_enabled && settings.appointment_reminder_email,
    smsAllowed: settings.sms_enabled && settings.appointment_reminder_sms,
    details: { doctor_id: appointment.doctor_id }
  });
}

async function notifyQueueUpdate(db, appointment, update = {}) {
  const settings = await getNotificationSettings(db);

  if (!settings.queue_updates_enabled) {
    await logNotification(db, {
      appointmentId: appointment.id,
      eventType: "queue_update",
      channel: "system",
      recipient: appointment.email || appointment.phone,
      message: `Queue update skipped for appointment #${appointment.id}`,
      sentStatus: "disabled",
      details: update
    });
    return [];
  }

  const queueNumber = update.queue_number || appointment.queue_number || "-";
  const doctorName = update.doctor_name || appointment.doctor_name || "your doctor";
  const status = update.status || appointment.status || "updated";
  const message = `Queue update: your queue number is ${queueNumber} with Dr. ${doctorName}. Current status: ${status}.`;

  return dispatchNotificationChannels(db, {
    appointmentId: appointment.id,
    eventType: "queue_update",
    emailRecipient: appointment.email,
    smsRecipient: appointment.phone,
    subject: "Queue update",
    message,
    emailAllowed: settings.email_enabled,
    smsAllowed: settings.sms_enabled,
    details: update
  });
}

async function notifyMissedAppointment(db, appointment) {
  const settings = await getNotificationSettings(db);

  if (!settings.missed_appointment_enabled) {
    return [];
  }

  const message = `We noticed you missed your appointment with Dr. ${appointment.doctor_name} scheduled for ${appointment.appointment_date} at ${appointment.appointment_time}. Please contact the clinic to reschedule.`;

  return dispatchNotificationChannels(db, {
    appointmentId: appointment.id,
    eventType: "missed_appointment",
    emailRecipient: appointment.email,
    smsRecipient: appointment.phone,
    subject: "Missed appointment notice",
    message,
    emailAllowed: settings.email_enabled,
    smsAllowed: settings.sms_enabled,
    details: { doctor_id: appointment.doctor_id }
  });
}

async function getAppointmentNotificationContext(db, appointmentId) {
  const rows = await db.queryAsync(
    `SELECT a.id, a.doctor_id, a.queue_number, a.status, a.appointment_date, a.appointment_time,
            COALESCE(p.full_name, a.patient_name) AS patient_name,
            COALESCE(p.email, a.patient_email) AS email,
            COALESCE(p.phone, a.patient_phone) AS phone,
            d.name AS doctor_name
     FROM appointments a
     LEFT JOIN patients p ON p.id = a.patient_id
     LEFT JOIN doctors d ON d.id = a.doctor_id
     WHERE a.id = ?
     LIMIT 1`,
    [appointmentId]
  );

  return rows[0] || null;
}

async function notifyQueueUpdateForAppointment(db, appointmentId, update = {}) {
  const appointment = await getAppointmentNotificationContext(db, appointmentId);
  if (!appointment) return [];
  return notifyQueueUpdate(db, appointment, update);
}

async function processScheduledNotifications(db) {
  const settings = await getNotificationSettings(db);
  const summary = { remindersSent: 0, missedSent: 0 };

  const reminderRows = await db.queryAsync(
    `SELECT a.id, a.doctor_id, a.queue_number, a.status, a.appointment_date, a.appointment_time,
            COALESCE(p.full_name, a.patient_name) AS patient_name,
            COALESCE(p.email, a.patient_email) AS email,
            COALESCE(p.phone, a.patient_phone) AS phone,
            d.name AS doctor_name
     FROM appointments a
     LEFT JOIN patients p ON p.id = a.patient_id
     LEFT JOIN doctors d ON d.id = a.doctor_id
     WHERE a.status = 'Waiting'
       AND a.reminder_notified_at IS NULL
       AND TIMESTAMPDIFF(MINUTE, NOW(), STR_TO_DATE(CONCAT(a.appointment_date, ' ', a.appointment_time), '%Y-%m-%d %H:%i')) BETWEEN 0 AND ?`,
    [settings.reminder_lead_minutes]
  );

  for (const appointment of reminderRows) {
    await notifyAppointmentReminder(db, appointment);
    await db.queryAsync(`UPDATE appointments SET reminder_notified_at = NOW() WHERE id = ?`, [appointment.id]);
    summary.remindersSent += 1;
  }

  const missedRows = await db.queryAsync(
    `SELECT a.id, a.doctor_id, a.queue_number, a.status, a.appointment_date, a.appointment_time,
            COALESCE(p.full_name, a.patient_name) AS patient_name,
            COALESCE(p.email, a.patient_email) AS email,
            COALESCE(p.phone, a.patient_phone) AS phone,
            d.name AS doctor_name
     FROM appointments a
     LEFT JOIN patients p ON p.id = a.patient_id
     LEFT JOIN doctors d ON d.id = a.doctor_id
     WHERE a.status = 'Waiting'
       AND a.missed_notified_at IS NULL
       AND TIMESTAMPDIFF(MINUTE, STR_TO_DATE(CONCAT(a.appointment_date, ' ', a.appointment_time), '%Y-%m-%d %H:%i'), NOW()) >= ?`,
    [settings.missed_grace_minutes]
  );

  for (const appointment of missedRows) {
    await notifyMissedAppointment(db, appointment);
    await db.queryAsync(`UPDATE appointments SET missed_notified_at = NOW() WHERE id = ?`, [appointment.id]);
    summary.missedSent += 1;
  }

  return summary;
}

module.exports = {
  sendEmailReminder,
  sendSmsReminder,
  getNotificationSettings,
  updateNotificationSettings,
  logNotification,
  notifyAppointmentConfirmation,
  notifyAppointmentReminder,
  notifyQueueUpdate,
  notifyQueueUpdateForAppointment,
  notifyMissedAppointment,
  processScheduledNotifications
};
