const express = require("express");
const crypto = require("crypto");
const Joi = require("joi");
const db = require("../db");
const { sendEmailReminder } = require("../services/notificationService");
const { hashPassword, comparePassword, isBcryptHash } = require("../utils/security");
const { syncLegacyAppointmentPatients } = require("../utils/patientSync");
const { signAccessToken, signRefreshToken, verifyToken, authenticate, requireRole } = require("../middleware/auth");
const { logAuthEvent } = require("../utils/auditLogger");

const router = express.Router();

function generateVerificationToken() {
  return crypto.randomBytes(24).toString("hex");
}

function buildVerificationLink(token) {
  const baseUrl = process.env.BACKEND_BASE_URL || "http://localhost:5000";
  return `${baseUrl}/api/patients/verify-email?token=${encodeURIComponent(token)}`;
}

async function saveSession(userId, refreshToken) {
  await db.queryAsync(
    `UPDATE users
     SET refresh_token = ?, refresh_expires_at = DATE_ADD(NOW(), INTERVAL 7 DAY), last_login_at = NOW()
     WHERE userId = ?`,
    [refreshToken, userId]
  );
}

const registerSchema = Joi.object({
  fullName: Joi.string().min(3).max(100).required(),
  email: Joi.string().email().required(),
  phone: Joi.string().allow("", null),
  icNumber: Joi.string().min(6).max(30).required(),
  password: Joi.string().min(6).required()
});

router.post("/register", async (req, res) => {
  try {
    const { error, value } = registerSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        message: "Validation failed",
        errors: error.details.map((detail) => detail.message)
      });
    }

    const existing = await db.queryAsync(
      "SELECT id FROM patients WHERE email = ? OR ic_number = ? LIMIT 1",
      [value.email, value.icNumber]
    );

    if (existing.length > 0) {
      return res.status(409).json({ message: "Patient email or IC already exists" });
    }

    const hashedPassword = await hashPassword(value.password);

    const result = await db.queryAsync(
      `INSERT INTO patients (full_name, email, phone, ic_number, password)
       VALUES (?, ?, ?, ?, ?)`,
      [value.fullName, value.email, value.phone || null, value.icNumber, hashedPassword]
    );

    const verificationToken = generateVerificationToken();

    await db.queryAsync(
      `INSERT INTO users (fullName, email, password, role, linked_patient_id, email_verified, verification_token, verification_expires_at)
       VALUES (?, ?, ?, 'Patient', ?, 0, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR))`,
      [value.fullName, value.email, hashedPassword, result.insertId, verificationToken]
    );

    await sendEmailReminder({
      to: value.email,
      subject: "Verify your Smart Clinic account",
      text: `Hi ${value.fullName},\n\nPlease verify your email to activate your account:\n${buildVerificationLink(verificationToken)}\n\nThis link expires in 24 hours.`
    });

    await logAuthEvent({
      req,
      eventType: "PATIENT_REGISTER",
      status: "SUCCESS",
      email: value.email,
      role: "Patient",
      details: { patientId: result.insertId }
    });

    res.status(201).json({
      message: "Patient account created. Please verify your email before logging in.",
      patient: {
        id: result.insertId,
        fullName: value.fullName,
        email: value.email,
        phone: value.phone || null,
        icNumber: value.icNumber
      }
    });
  } catch (error) {
    console.error("Patient registration error:", error.message);
    await logAuthEvent({
      req,
      eventType: "PATIENT_REGISTER",
      status: "FAILED",
      email: String(req.body?.email || "").trim().toLowerCase(),
      role: "Patient",
      details: { reason: error.message }
    });
    res.status(500).json({ message: "Failed to register patient" });
  }
});

router.get("/verify-email", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ message: "Verification token is required" });
    }

    const users = await db.queryAsync(
      `SELECT userId, email
       FROM users
       WHERE role = 'Patient'
         AND verification_token = ?
         AND verification_expires_at >= NOW()
       LIMIT 1`,
      [token]
    );

    if (users.length === 0) {
      return res.status(400).json({ message: "Invalid or expired verification token" });
    }

    await db.queryAsync(
      `UPDATE users
       SET email_verified = 1,
           verification_token = NULL,
           verification_expires_at = NULL
       WHERE userId = ?`,
      [users[0].userId]
    );

    await logAuthEvent({
      req,
      eventType: "PATIENT_EMAIL_VERIFIED",
      status: "SUCCESS",
      userId: users[0].userId,
      email: users[0].email,
      role: "Patient"
    });

    return res.json({ message: "Email verified successfully. You can now log in." });
  } catch (error) {
    console.error("Patient verify email error:", error.message);
    return res.status(500).json({ message: "Failed to verify email" });
  }
});

router.post("/resend-verification", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const rows = await db.queryAsync(
      "SELECT userId, fullName, email_verified FROM users WHERE LOWER(email) = ? AND role = 'Patient' LIMIT 1",
      [email]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Patient account not found" });
    }

    if (Number(rows[0].email_verified) === 1) {
      return res.json({ message: "Email is already verified" });
    }

    const verificationToken = generateVerificationToken();
    await db.queryAsync(
      `UPDATE users
       SET verification_token = ?, verification_expires_at = DATE_ADD(NOW(), INTERVAL 24 HOUR)
       WHERE userId = ?`,
      [verificationToken, rows[0].userId]
    );

    await sendEmailReminder({
      to: email,
      subject: "Verify your Smart Clinic account",
      text: `Please verify your email:\n${buildVerificationLink(verificationToken)}\n\nThis link expires in 24 hours.`
    });

    await logAuthEvent({
      req,
      eventType: "PATIENT_VERIFY_RESEND",
      status: "SUCCESS",
      userId: rows[0].userId,
      email,
      role: "Patient"
    });

    return res.json({ message: "Verification email sent" });
  } catch (error) {
    console.error("Resend verification error:", error.message);
    return res.status(500).json({ message: "Failed to resend verification email" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "").trim();
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    let userRows = await db.queryAsync(
      "SELECT userId, fullName, email, password, role, linked_patient_id, email_verified FROM users WHERE LOWER(email) = ? AND role = 'Patient' LIMIT 1",
      [email]
    );

    // Legacy compatibility: promote existing patient row into users table.
    if (userRows.length === 0) {
      const legacyPatients = await db.queryAsync("SELECT * FROM patients WHERE LOWER(email) = ? LIMIT 1", [email]);
      if (legacyPatients.length > 0) {
        const p = legacyPatients[0];
        await db.queryAsync(
          `INSERT IGNORE INTO users (fullName, email, password, role, linked_patient_id, email_verified)
           VALUES (?, ?, ?, 'Patient', ?, 1)`,
          [p.full_name, p.email, p.password, p.id]
        );
        userRows = await db.queryAsync(
          "SELECT userId, fullName, email, password, role, linked_patient_id, email_verified FROM users WHERE LOWER(email) = ? AND role = 'Patient' LIMIT 1",
          [email]
        );
      }
    }

    if (userRows.length === 0) {
      await logAuthEvent({
        req,
        eventType: "PATIENT_LOGIN",
        status: "FAILED",
        email,
        role: "Patient",
        details: { reason: "user_not_found" }
      });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const user = userRows[0];
    const passwordMatched = await comparePassword(password, user.password);

    if (!passwordMatched) {
      await logAuthEvent({
        req,
        eventType: "PATIENT_LOGIN",
        status: "FAILED",
        userId: user.userId,
        email,
        role: "Patient",
        details: { reason: "invalid_password" }
      });
      return res.status(401).json({ message: "Invalid credentials" });
    }

    if (Number(user.email_verified) !== 1) {
      await logAuthEvent({
        req,
        eventType: "PATIENT_LOGIN",
        status: "FAILED",
        userId: user.userId,
        email,
        role: "Patient",
        details: { reason: "email_not_verified" }
      });
      return res.status(403).json({ message: "Please verify your email before logging in" });
    }

    if (!isBcryptHash(user.password)) {
      const rehashed = await hashPassword(password);
      await db.queryAsync("UPDATE users SET password = ? WHERE userId = ?", [rehashed, user.userId]);
      if (user.linked_patient_id) {
        await db.queryAsync("UPDATE patients SET password = ? WHERE id = ?", [rehashed, user.linked_patient_id]);
      }
      user.password = rehashed;
    }

    const token = signAccessToken({ id: user.userId, role: "Patient", email: user.email, patientId: user.linked_patient_id || null });
    const refreshToken = signRefreshToken({ id: user.userId, role: "Patient", email: user.email });
    await saveSession(user.userId, refreshToken);

    let patientRows = [];
    if (user.linked_patient_id) {
      patientRows = await db.queryAsync("SELECT * FROM patients WHERE id = ? LIMIT 1", [user.linked_patient_id]);
    } else {
      patientRows = await db.queryAsync("SELECT * FROM patients WHERE LOWER(email) = ? LIMIT 1", [email]);
    }

    const patient = patientRows[0] || null;

    await logAuthEvent({
      req,
      eventType: "PATIENT_LOGIN",
      status: "SUCCESS",
      userId: user.userId,
      email,
      role: "Patient"
    });

    res.json({
      message: "Login successful",
      token,
      refreshToken,
      patient: {
        id: patient?.id || user.linked_patient_id,
        fullName: patient?.full_name || user.fullName,
        email: patient?.email || user.email,
        phone: patient?.phone || null,
        icNumber: patient?.ic_number || null
      }
    });
  } catch (error) {
    console.error("Patient login error:", error.message);
    await logAuthEvent({
      req,
      eventType: "PATIENT_LOGIN",
      status: "FAILED",
      email: String(req.body?.email || "").trim().toLowerCase(),
      role: "Patient",
      details: { reason: error.message }
    });
    res.status(500).json({ message: "Failed to login patient" });
  }
});

router.post("/refresh-token", async (req, res) => {
  try {
    const refreshToken = String(req.body?.refreshToken || "").trim();
    if (!refreshToken) {
      return res.status(400).json({ message: "refreshToken is required" });
    }

    let payload;
    try {
      payload = verifyToken(refreshToken);
    } catch (_err) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    if (payload.type !== "refresh" || payload.role !== "Patient") {
      return res.status(403).json({ message: "Invalid refresh token scope" });
    }

    const users = await db.queryAsync(
      `SELECT userId, email, role, linked_patient_id
       FROM users
       WHERE userId = ? AND role = 'Patient' AND refresh_token = ? AND refresh_expires_at >= NOW()
       LIMIT 1`,
      [payload.id, refreshToken]
    );

    if (users.length === 0) {
      return res.status(401).json({ message: "Refresh token expired or revoked" });
    }

    const user = users[0];
    const newAccessToken = signAccessToken({ id: user.userId, role: "Patient", email: user.email, patientId: user.linked_patient_id || null });
    const newRefreshToken = signRefreshToken({ id: user.userId, role: "Patient", email: user.email });
    await saveSession(user.userId, newRefreshToken);

    await logAuthEvent({
      req,
      eventType: "PATIENT_REFRESH_TOKEN",
      status: "SUCCESS",
      userId: user.userId,
      email: user.email,
      role: "Patient"
    });

    return res.json({ token: newAccessToken, refreshToken: newRefreshToken });
  } catch (error) {
    console.error("Patient refresh token error:", error.message);
    return res.status(500).json({ message: "Failed to refresh token" });
  }
});

router.post("/logout", authenticate, requireRole("Patient"), async (req, res) => {
  try {
    await db.queryAsync(
      "UPDATE users SET refresh_token = NULL, refresh_expires_at = NULL WHERE userId = ?",
      [req.user.id]
    );

    await logAuthEvent({
      req,
      eventType: "PATIENT_LOGOUT",
      status: "SUCCESS",
      userId: req.user.id,
      email: req.user.email,
      role: "Patient"
    });

    return res.json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("Patient logout error:", error.message);
    return res.status(500).json({ message: "Failed to logout" });
  }
});

router.get("/me/history", authenticate, requireRole("Patient"), async (req, res) => {
  try {
    const userRows = await db.queryAsync(
      "SELECT linked_patient_id, email FROM users WHERE userId = ? AND role = 'Patient' LIMIT 1",
      [req.user.id]
    );

    if (userRows.length === 0) {
      return res.status(404).json({ message: "Patient account not found" });
    }

    const patientId = userRows[0].linked_patient_id;
    const patientEmail = userRows[0].email;

    const patientRows = patientId
      ? await db.queryAsync("SELECT * FROM patients WHERE id = ? LIMIT 1", [patientId])
      : await db.queryAsync("SELECT * FROM patients WHERE LOWER(email) = ? LIMIT 1", [String(patientEmail).toLowerCase()]);

    if (patientRows.length === 0) {
      return res.status(404).json({ message: "Patient not found" });
    }

    const appointments = await db.queryAsync(
      `SELECT a.id, a.patient_name, a.ic_number, a.doctor_id, a.appointment_date, a.appointment_time,
              a.queue_number, a.status, a.description, d.name AS doctor_name, d.specialization
       FROM appointments a
       LEFT JOIN doctors d ON d.id = a.doctor_id
       WHERE a.patient_id = ? OR a.ic_number = ?
       ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
      [req.user.id, patientRows[0].ic_number]
    );

    const medicalRecords = await db.queryAsync(
      `SELECT mr.id, mr.appointment_id, mr.doctor_id, mr.diagnosis, mr.prescriptions, mr.notes,
              mr.visit_date, mr.created_at, d.name AS doctor_name, d.specialization
       FROM medical_records mr
       LEFT JOIN doctors d ON d.id = mr.doctor_id
       WHERE mr.patient_id = ?
       ORDER BY mr.visit_date DESC, mr.created_at DESC`,
      [req.user.id]
    );

    const patient = {
      id: patientRows[0].id,
      full_name: patientRows[0].full_name,
      email: patientRows[0].email,
      phone: patientRows[0].phone,
      ic_number: patientRows[0].ic_number,
      created_at: patientRows[0].created_at
    };

    res.json({ patient, appointments, medicalRecords });
  } catch (error) {
    console.error("Patient history error:", error.message);
    res.status(500).json({ message: "Failed to load patient history" });
  }
});

module.exports = router;

/* =========================================================
   ADMIN PATIENT MANAGEMENT  (all routes require Admin JWT)
   ========================================================= */

// ── LIST all patients with search & filter ──────────────────
router.get("/", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    await syncLegacyAppointmentPatients(db);

    const { search, gender, date_of_birth, date_of_birth_from, date_of_birth_to, page, limit } = req.query;

    const conditions = [];
    const params = [];

    if (search) {
      const like = `%${String(search).toLowerCase()}%`;
      conditions.push("(LOWER(p.full_name) LIKE ? OR LOWER(p.email) LIKE ? OR p.ic_number LIKE ? OR p.phone LIKE ?)");
      params.push(like, like, `%${search}%`, `%${search}%`);
    }
    if (gender) {
      conditions.push("p.gender = ?");
      params.push(gender);
    }
    if (date_of_birth) {
      conditions.push("p.date_of_birth = ?");
      params.push(date_of_birth);
    }
    if (date_of_birth_from) {
      conditions.push("p.date_of_birth >= ?");
      params.push(date_of_birth_from);
    }
    if (date_of_birth_to) {
      conditions.push("p.date_of_birth <= ?");
      params.push(date_of_birth_to);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 20));
    const offset = (pageNum - 1) * pageSize;

    const [countRow] = await db.queryAsync(
      `SELECT COUNT(*) AS total FROM patients p ${where}`,
      params
    );

    const rows = await db.queryAsync(
      `SELECT p.id, p.full_name, p.email, p.phone, p.ic_number,
              p.date_of_birth, p.gender, p.created_at,
              TIMESTAMPDIFF(YEAR, p.date_of_birth, CURDATE()) AS age,
              (
                SELECT d.name
                FROM appointments a2
                LEFT JOIN doctors d ON d.id = a2.doctor_id
                WHERE (a2.patient_id = p.id OR a2.ic_number = p.ic_number)
                  AND a2.appointment_date = CURDATE()
                  AND a2.status != 'Cancelled'
                ORDER BY
                  CASE a2.status
                    WHEN 'In Progress' THEN 1
                    WHEN 'Waiting' THEN 2
                    WHEN 'Completed' THEN 3
                    ELSE 4
                  END,
                  a2.queue_number ASC,
                  a2.appointment_time ASC
                LIMIT 1
              ) AS today_doctor_name,
              (
                SELECT a2.queue_number
                FROM appointments a2
                WHERE (a2.patient_id = p.id OR a2.ic_number = p.ic_number)
                  AND a2.appointment_date = CURDATE()
                  AND a2.status != 'Cancelled'
                ORDER BY
                  CASE a2.status
                    WHEN 'In Progress' THEN 1
                    WHEN 'Waiting' THEN 2
                    WHEN 'Completed' THEN 3
                    ELSE 4
                  END,
                  a2.queue_number ASC,
                  a2.appointment_time ASC
                LIMIT 1
              ) AS today_queue_number,
              (
                SELECT a2.status
                FROM appointments a2
                WHERE (a2.patient_id = p.id OR a2.ic_number = p.ic_number)
                  AND a2.appointment_date = CURDATE()
                  AND a2.status != 'Cancelled'
                ORDER BY
                  CASE a2.status
                    WHEN 'In Progress' THEN 1
                    WHEN 'Waiting' THEN 2
                    WHEN 'Completed' THEN 3
                    ELSE 4
                  END,
                  a2.queue_number ASC,
                  a2.appointment_time ASC
                LIMIT 1
              ) AS today_status,
              (
                SELECT a2.appointment_time
                FROM appointments a2
                WHERE (a2.patient_id = p.id OR a2.ic_number = p.ic_number)
                  AND a2.appointment_date = CURDATE()
                  AND a2.status != 'Cancelled'
                ORDER BY
                  CASE a2.status
                    WHEN 'In Progress' THEN 1
                    WHEN 'Waiting' THEN 2
                    WHEN 'Completed' THEN 3
                    ELSE 4
                  END,
                  a2.queue_number ASC,
                  a2.appointment_time ASC
                LIMIT 1
              ) AS today_appointment_time
       FROM patients p
       ${where}
       ORDER BY p.full_name ASC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    return res.json({
      total: countRow.total,
      page: pageNum,
      limit: pageSize,
      patients: rows
    });
  } catch (error) {
    console.error("Admin list patients error:", error.message);
    return res.status(500).json({ message: "Failed to load patients" });
  }
});

// ── GET single patient ───────────────────────────────────────
router.get("/:id", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rows = await db.queryAsync(
      `SELECT id, full_name, email, phone, ic_number, date_of_birth, gender, created_at,
              TIMESTAMPDIFF(YEAR, date_of_birth, CURDATE()) AS age
       FROM patients WHERE id = ? LIMIT 1`,
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Patient not found" });
    }
    return res.json(rows[0]);
  } catch (error) {
    console.error("Admin get patient error:", error.message);
    return res.status(500).json({ message: "Failed to load patient" });
  }
});

// ── CREATE patient (admin, no email verification needed) ─────
const adminCreateSchema = Joi.object({
  fullName:     Joi.string().min(3).max(100).required(),
  email:        Joi.string().email().required(),
  phone:        Joi.string().allow("", null),
  icNumber:     Joi.string().min(6).max(30).required(),
  dateOfBirth:  Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow("", null),
  gender:       Joi.string().valid("Male", "Female", "Other").allow("", null),
  password:     Joi.string().min(6).required()
});

router.post("/admin/create", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const { error, value } = adminCreateSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        message: "Validation failed",
        errors: error.details.map((d) => d.message)
      });
    }

    const existing = await db.queryAsync(
      "SELECT id FROM patients WHERE email = ? OR ic_number = ? LIMIT 1",
      [value.email, value.icNumber]
    );
    if (existing.length > 0) {
      return res.status(409).json({ message: "Patient email or IC already exists" });
    }

    const hashedPassword = await hashPassword(value.password);

    const result = await db.queryAsync(
      `INSERT INTO patients (full_name, email, phone, ic_number, password, date_of_birth, gender)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [value.fullName, value.email, value.phone || null, value.icNumber, hashedPassword,
       value.dateOfBirth || null, value.gender || null]
    );

    await db.queryAsync(
      `INSERT IGNORE INTO users (fullName, email, password, role, linked_patient_id, email_verified)
       VALUES (?, ?, ?, 'Patient', ?, 1)`,
      [value.fullName, value.email, hashedPassword, result.insertId]
    );

    await logAuthEvent({
      req,
      eventType: "ADMIN_CREATE_PATIENT",
      status: "SUCCESS",
      email: value.email,
      role: "Patient",
      details: { patientId: result.insertId, createdByUserId: req.user.id }
    });

    return res.status(201).json({
      message: "Patient created successfully",
      patient: {
        id: result.insertId,
        fullName: value.fullName,
        email: value.email,
        phone: value.phone || null,
        icNumber: value.icNumber,
        dateOfBirth: value.dateOfBirth || null,
        gender: value.gender || null
      }
    });
  } catch (error) {
    console.error("Admin create patient error:", error.message);
    return res.status(500).json({ message: "Failed to create patient" });
  }
});

// ── UPDATE patient ───────────────────────────────────────────
const adminUpdateSchema = Joi.object({
  fullName:    Joi.string().min(3).max(100),
  email:       Joi.string().email(),
  phone:       Joi.string().allow("", null),
  icNumber:    Joi.string().min(6).max(30),
  dateOfBirth: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).allow("", null),
  gender:      Joi.string().valid("Male", "Female", "Other").allow("", null)
});

router.put("/:id", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { error, value } = adminUpdateSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        message: "Validation failed",
        errors: error.details.map((d) => d.message)
      });
    }

    const existing = await db.queryAsync("SELECT id, email FROM patients WHERE id = ? LIMIT 1", [id]);
    if (existing.length === 0) {
      return res.status(404).json({ message: "Patient not found" });
    }

    // Check email/IC uniqueness if being changed
    if (value.email && value.email !== existing[0].email) {
      const conflict = await db.queryAsync(
        "SELECT id FROM patients WHERE email = ? AND id != ? LIMIT 1",
        [value.email, id]
      );
      if (conflict.length > 0) {
        return res.status(409).json({ message: "Email already used by another patient" });
      }
    }
    if (value.icNumber) {
      const icConflict = await db.queryAsync(
        "SELECT id FROM patients WHERE ic_number = ? AND id != ? LIMIT 1",
        [value.icNumber, id]
      );
      if (icConflict.length > 0) {
        return res.status(409).json({ message: "IC number already used by another patient" });
      }
    }

    const fields = [];
    const params = [];
    if (value.fullName !== undefined)   { fields.push("full_name = ?");     params.push(value.fullName); }
    if (value.email !== undefined)      { fields.push("email = ?");         params.push(value.email); }
    if (value.phone !== undefined)      { fields.push("phone = ?");         params.push(value.phone || null); }
    if (value.icNumber !== undefined)   { fields.push("ic_number = ?");     params.push(value.icNumber); }
    if (value.dateOfBirth !== undefined){ fields.push("date_of_birth = ?"); params.push(value.dateOfBirth || null); }
    if (value.gender !== undefined)     { fields.push("gender = ?");        params.push(value.gender || null); }

    if (fields.length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    params.push(id);
    await db.queryAsync(`UPDATE patients SET ${fields.join(", ")} WHERE id = ?`, params);

    // Keep users table in sync
    if (value.fullName || value.email) {
      const syncFields = [];
      const syncParams = [];
      if (value.fullName) { syncFields.push("fullName = ?"); syncParams.push(value.fullName); }
      if (value.email)    { syncFields.push("email = ?");    syncParams.push(value.email); }
      syncParams.push(id);
      await db.queryAsync(
        `UPDATE users SET ${syncFields.join(", ")} WHERE linked_patient_id = ?`,
        syncParams
      );
    }

    return res.json({ message: "Patient updated successfully" });
  } catch (error) {
    console.error("Admin update patient error:", error.message);
    return res.status(500).json({ message: "Failed to update patient" });
  }
});

// ── DELETE patient ───────────────────────────────────────────
router.delete("/:id", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const rows = await db.queryAsync("SELECT id FROM patients WHERE id = ? LIMIT 1", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Patient not found" });
    }

    await db.queryAsync("DELETE FROM users WHERE linked_patient_id = ?", [id]);
    await db.queryAsync("DELETE FROM patients WHERE id = ?", [id]);

    await logAuthEvent({
      req,
      eventType: "ADMIN_DELETE_PATIENT",
      status: "SUCCESS",
      role: "Admin",
      details: { deletedPatientId: id, deletedByUserId: req.user.id }
    });

    return res.json({ message: "Patient deleted successfully" });
  } catch (error) {
    console.error("Admin delete patient error:", error.message);
    return res.status(500).json({ message: "Failed to delete patient" });
  }
});

// ── ADMIN: view full visit history for a patient ─────────────
router.get("/:id/history", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const patientRows = await db.queryAsync(
      `SELECT id, full_name, email, phone, ic_number, date_of_birth, gender, created_at,
              TIMESTAMPDIFF(YEAR, date_of_birth, CURDATE()) AS age
       FROM patients WHERE id = ? LIMIT 1`,
      [id]
    );
    if (patientRows.length === 0) {
      return res.status(404).json({ message: "Patient not found" });
    }

    const appointments = await db.queryAsync(
      `SELECT a.id, a.appointment_date, a.appointment_time, a.queue_number, a.status,
              a.description, a.check_in_confirmed, a.created_at,
              d.name AS doctor_name, d.specialization
       FROM appointments a
       LEFT JOIN doctors d ON d.id = a.doctor_id
       WHERE a.patient_id = ? OR a.ic_number = ?
       ORDER BY a.appointment_date DESC, a.appointment_time DESC`,
      [id, patientRows[0].ic_number]
    );

    const medicalRecords = await db.queryAsync(
      `SELECT mr.id, mr.appointment_id, mr.diagnosis, mr.prescriptions, mr.notes,
              mr.visit_date, mr.created_at, d.name AS doctor_name, d.specialization
       FROM medical_records mr
       LEFT JOIN doctors d ON d.id = mr.doctor_id
       WHERE mr.patient_id = ?
       ORDER BY mr.visit_date DESC, mr.created_at DESC`,
      [id]
    );

    return res.json({
      patient: patientRows[0],
      appointments,
      medicalRecords
    });
  } catch (error) {
    console.error("Admin patient history error:", error.message);
    return res.status(500).json({ message: "Failed to load patient history" });
  }
});
