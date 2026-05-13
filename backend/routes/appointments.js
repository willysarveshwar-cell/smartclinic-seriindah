const express = require("express");
const Joi = require("joi");
const router = express.Router();
const db = require("../db");
const {
  notifyAppointmentConfirmation,
  notifyQueueUpdateForAppointment
} = require("../services/notificationService");
const { getDoctorAverageMinutes } = require("../utils/waitEstimator");
const { upsertPatientFromAppointment } = require("../utils/patientSync");
const { authenticate, requireRole } = require("../middleware/auth");

const appointmentSchema = Joi.object({
  patient_name: Joi.string().min(3).max(100).required(),
  ic_number: Joi.string().min(6).max(30).required(),
  doctor_id: Joi.number().integer().required(),
  appointment_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  appointment_time: Joi.string().pattern(/^\d{2}:\d{2}$/).required(),
  patient_id: Joi.number().integer().optional(),
  patient_email: Joi.string().email().allow("", null),
  patient_phone: Joi.string().allow("", null)
});

function generateSlots(startTime, endTime) {
  const slots = [];
  const [startHour, startMinute] = startTime.split(":").map(Number);
  const [endHour, endMinute] = endTime.split(":").map(Number);

  let cursor = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;

  while (cursor < end) {
    const hour = Math.floor(cursor / 60);
    const minute = cursor % 60;
    slots.push(`${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
    cursor += 30;
  }

  return slots;
}

function isValidDefaultClinicSlot(time) {
  const defaultSlots = generateSlots("09:00", "17:00");
  return defaultSlots.includes(String(time || "").slice(0, 5));
}

async function validateDoctorAvailability(doctorId, appointmentDate, appointmentTime) {
  const leaveRows = await db.queryAsync(
    `SELECT id
     FROM doctor_leaves
     WHERE doctor_id = ?
       AND status = 'Approved'
       AND ? BETWEEN start_date AND end_date
     LIMIT 1`,
    [doctorId, appointmentDate]
  );

  if (leaveRows.length > 0) {
    return { valid: false, message: "Doctor is on approved leave for the selected date" };
  }

  const jsDate = new Date(`${appointmentDate}T00:00:00`);
  if (Number.isNaN(jsDate.getTime())) {
    return { valid: false, message: "Invalid appointment date" };
  }

  const dayOfWeek = jsDate.getDay();
  const availability = await db.queryAsync(
    `SELECT start_time, end_time
     FROM doctor_availability
     WHERE doctor_id = ? AND day_of_week = ? AND is_active = 1
     ORDER BY start_time ASC`,
    [doctorId, dayOfWeek]
  );

  const normalizedTime = String(appointmentTime || "").slice(0, 5);
  const configuredSlots = availability.flatMap((row) =>
    generateSlots(String(row.start_time).slice(0, 5), String(row.end_time).slice(0, 5))
  );

  if (configuredSlots.length > 0) {
    if (!configuredSlots.includes(normalizedTime)) {
      return { valid: false, message: "Selected time is outside the doctor's available schedule" };
    }
    return { valid: true };
  }

  if (!isValidDefaultClinicSlot(normalizedTime)) {
    return { valid: false, message: "Selected time is outside clinic operating hours" };
  }

  return { valid: true };
}

async function detectAppointmentConflict({ doctorId, appointmentDate, appointmentTime, icNumber, excludeId = null }) {
  const duplicateSlotParams = [doctorId, appointmentDate, appointmentTime];
  const duplicateSlotSql = `SELECT id FROM appointments
    WHERE doctor_id = ? AND appointment_date = ? AND LEFT(appointment_time, 5) = ? AND status != 'Cancelled'`;
  const duplicateSlot = await db.queryAsync(
    excludeId ? `${duplicateSlotSql} AND id != ? LIMIT 1` : `${duplicateSlotSql} LIMIT 1`,
    excludeId ? [...duplicateSlotParams, excludeId] : duplicateSlotParams
  );

  if (duplicateSlot.length > 0) {
    return { ok: false, status: 409, message: "Selected time slot is already booked for this doctor" };
  }

  const patientConflictParams = [icNumber, appointmentDate, appointmentTime];
  const patientConflictSql = `SELECT id FROM appointments
    WHERE ic_number = ? AND appointment_date = ? AND LEFT(appointment_time, 5) = ? AND status != 'Cancelled'`;
  const samePatientConflict = await db.queryAsync(
    excludeId ? `${patientConflictSql} AND id != ? LIMIT 1` : `${patientConflictSql} LIMIT 1`,
    excludeId ? [...patientConflictParams, excludeId] : patientConflictParams
  );

  if (samePatientConflict.length > 0) {
    return { ok: false, status: 409, message: "Patient already has an appointment at this date and time" };
  }

  return { ok: true };
}

async function getNextQueueNumber(appointmentDate) {
  const [countResult] = await db.queryAsync(
    "SELECT COUNT(*) AS total FROM appointments WHERE appointment_date = ?",
    [appointmentDate]
  );
  return Number(countResult?.total || 0) + 1;
}

/**
 * BOOK APPOINTMENT
 * - Auto-generate queue number per day
 * - Store appointment in database
 */
router.post("/", async (req, res) => {
  try {
    const { error, value } = appointmentSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.details.map((item) => item.message)
      });
    }

    const availabilityCheck = await validateDoctorAvailability(
      value.doctor_id,
      value.appointment_date,
      value.appointment_time
    );
    if (!availabilityCheck.valid) {
      return res.status(409).json({ success: false, message: availabilityCheck.message });
    }

    const conflict = await detectAppointmentConflict({
      doctorId: value.doctor_id,
      appointmentDate: value.appointment_date,
      appointmentTime: value.appointment_time,
      icNumber: value.ic_number
    });
    if (!conflict.ok) {
      return res.status(conflict.status).json({ success: false, message: conflict.message });
    }

    const queue_number = await getNextQueueNumber(value.appointment_date);
    const checkInToken = String(queue_number);

    const syncedPatient = await upsertPatientFromAppointment(db, value);

    const insertResult = await db.queryAsync(
      `INSERT INTO appointments
       (patient_name, ic_number, patient_email, patient_phone, doctor_id, appointment_date, appointment_time, queue_number, status, patient_id, check_in_token, check_in_confirmed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Waiting', ?, ?, 0, NOW())`,
      [
        value.patient_name,
        value.ic_number,
        value.patient_email || syncedPatient.email || null,
        value.patient_phone || syncedPatient.phone || null,
        value.doctor_id,
        value.appointment_date,
        value.appointment_time,
        queue_number,
        syncedPatient.id,
        checkInToken
      ]
    );

    const appointmentId = insertResult.insertId;
    const doctorRows = await db.queryAsync("SELECT name FROM doctors WHERE id = ? LIMIT 1", [value.doctor_id]);
    await notifyAppointmentConfirmation(db, {
      id: appointmentId,
      doctor_id: value.doctor_id,
      doctor_name: doctorRows[0]?.name || "Assigned Doctor",
      email: value.patient_email || syncedPatient.email || null,
      phone: value.patient_phone || syncedPatient.phone || null,
      appointment_date: value.appointment_date,
      appointment_time: value.appointment_time
    });

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", { appointmentId, queue_number, status: "Waiting" });
      io.emit("patients:updated", {
        patientId: syncedPatient.id,
        appointmentId,
        queue_number,
        status: "Waiting"
      });
    }

    res.json({
      success: true,
      message: "Appointment booked successfully",
      queue_number,
      appointmentId,
      checkInToken,
      checkInUrl: `http://localhost:5000/api/appointments/checkin/${checkInToken}`
    });
  } catch (err) {
    console.error("Insert appointment error:", err);
    res.status(500).json({
      success: false,
      message: "Failed to book appointment"
    });
  }
});

router.get("/slots", async (req, res) => {
  try {
    const { doctor_id, date } = req.query;
    if (!doctor_id || !date) {
      return res.status(400).json({ message: "doctor_id and date are required" });
    }

    const jsDate = new Date(`${date}T00:00:00`);
    if (Number.isNaN(jsDate.getTime())) {
      return res.status(400).json({ message: "Invalid date format" });
    }

    const leaveRows = await db.queryAsync(
      `SELECT id
       FROM doctor_leaves
       WHERE doctor_id = ?
         AND status = 'Approved'
         AND ? BETWEEN start_date AND end_date
       LIMIT 1`,
      [doctor_id, date]
    );

    if (leaveRows.length > 0) {
      return res.json({ doctor_id: Number(doctor_id), date, slots: [], leave: true });
    }

    const dayOfWeek = jsDate.getDay();
    const availability = await db.queryAsync(
      `SELECT start_time, end_time
       FROM doctor_availability
       WHERE doctor_id = ? AND day_of_week = ? AND is_active = 1
       ORDER BY start_time ASC`,
      [doctor_id, dayOfWeek]
    );

    const allSlots = availability.flatMap((row) =>
      generateSlots(row.start_time.slice(0, 5), row.end_time.slice(0, 5))
    );

    if (allSlots.length === 0) {
      return res.json({ doctor_id: Number(doctor_id), date, slots: [] });
    }

    const booked = await db.queryAsync(
      `SELECT appointment_time FROM appointments
       WHERE doctor_id = ? AND appointment_date = ? AND status != 'Cancelled'`,
      [doctor_id, date]
    );

    const bookedSet = new Set(booked.map((item) => item.appointment_time.slice(0, 5)));

    const slots = allSlots.map((slot) => ({
      time: slot,
      available: !bookedSet.has(slot)
    }));

    res.json({ doctor_id: Number(doctor_id), date, slots });
  } catch (error) {
    console.error("Load slots error:", error.message);
    res.status(500).json({ message: "Failed to load slots" });
  }
});

router.get("/", authenticate, requireRole("Doctor", "Admin"), async (req, res) => {
  try {
    const { doctor_id, date, status, patient_name, ic_number } = req.query;
    const conditions = [];
    const params = [];

    if (doctor_id) {
      conditions.push("a.doctor_id = ?");
      params.push(Number(doctor_id));
    }
    if (date) {
      conditions.push("a.appointment_date = ?");
      params.push(date);
    }
    if (status) {
      conditions.push("a.status = ?");
      params.push(status);
    }
    if (patient_name) {
      conditions.push("LOWER(a.patient_name) LIKE ?");
      params.push(`%${String(patient_name).toLowerCase()}%`);
    }
    if (ic_number) {
      conditions.push("a.ic_number LIKE ?");
      params.push(`%${ic_number}%`);
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const results = await db.queryAsync(
      `SELECT a.*, d.name AS doctor_name
       FROM appointments a
       LEFT JOIN doctors d ON d.id = a.doctor_id
       ${whereSql}
       ORDER BY a.appointment_date DESC, a.appointment_time ASC`,
      params
    );

    res.json(results);
  } catch (error) {
    console.error("Search appointments error:", error.message);
    res.status(500).json({ message: "Failed to load appointments" });
  }
});

/**
 * GET TODAY'S QUEUE (OPTIONAL – for Queue Page)
 */
router.get("/today", authenticate, requireRole("Doctor", "Admin"), async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const results = await db.queryAsync(
      `SELECT a.*, d.name as doctor_name
       FROM appointments a
       LEFT JOIN doctors d ON a.doctor_id = d.id
       WHERE a.appointment_date = ?
       ORDER BY a.queue_number`,
      [today]
    );
    res.json(results);
  } catch (error) {
    res.status(500).json({ success: false, message: "Failed to load today's appointments" });
  }
});

router.get("/checkin/:token", async (req, res) => {
  try {
    const { token } = req.params;

    const rows = await db.queryAsync(
      `SELECT a.id, a.patient_name, a.appointment_date, a.appointment_time, a.queue_number,
              a.status, a.check_in_confirmed, d.name AS doctor_name, a.doctor_id
       FROM appointments a
       LEFT JOIN doctors d ON d.id = a.doctor_id
       WHERE a.check_in_token = ? AND a.appointment_date = CURDATE()
       LIMIT 1`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Invalid QR check-in token" });
    }

    const appointment = rows[0];
    if (appointment.status === "Cancelled" || appointment.status === "Completed") {
      return res.status(400).json({
        success: false,
        message: `Cannot check in appointment with status ${appointment.status}`
      });
    }

    await db.queryAsync(
      `UPDATE appointments
       SET check_in_confirmed = 1,
           checked_in_at = COALESCE(checked_in_at, NOW()),
           updated_at = NOW()
       WHERE id = ?`,
      [appointment.id]
    );

    const averageConsultationMinutes = await getDoctorAverageMinutes(db, appointment.doctor_id);
    const [aheadRow] = await db.queryAsync(
      `SELECT COUNT(*) AS total
       FROM appointments
       WHERE appointment_date = ?
         AND doctor_id = ?
         AND queue_number < ?
         AND status IN ('Waiting', 'In Progress')`,
      [appointment.appointment_date, appointment.doctor_id, appointment.queue_number]
    );

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", {
        appointmentId: appointment.id,
        status: appointment.status,
        check_in_confirmed: 1
      });
      io.emit("patients:updated", {
        appointmentId: appointment.id,
        status: appointment.status,
        check_in_confirmed: 1
      });
    }

    await notifyQueueUpdateForAppointment(db, appointment.id, {
      status: appointment.status,
      queue_number: appointment.queue_number,
      check_in_confirmed: 1
    });

    return res.json({
      success: true,
      message: "Check-in confirmed",
      appointment: {
        id: appointment.id,
        patient_name: appointment.patient_name,
        doctor_name: appointment.doctor_name,
        appointment_date: appointment.appointment_date,
        appointment_time: appointment.appointment_time,
        queue_number: appointment.queue_number,
        status: appointment.status,
        check_in_confirmed: 1,
        estimated_waiting_time_minutes: Number(aheadRow?.total || 0) * averageConsultationMinutes
      }
    });
  } catch (error) {
    console.error("QR check-in error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to check in" });
  }
});

router.post("/checkin", async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ success: false, message: "token is required" });
    }

    const rows = await db.queryAsync(
      `SELECT a.id, a.patient_name, a.appointment_date, a.appointment_time, a.queue_number,
              a.status, a.check_in_confirmed, d.name AS doctor_name, a.doctor_id
       FROM appointments a
       LEFT JOIN doctors d ON d.id = a.doctor_id
       WHERE a.check_in_token = ? AND a.appointment_date = CURDATE()
       LIMIT 1`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: "Invalid QR check-in token" });
    }

    const appointment = rows[0];
    if (appointment.status === "Cancelled" || appointment.status === "Completed") {
      return res.status(400).json({
        success: false,
        message: `Cannot check in appointment with status ${appointment.status}`
      });
    }

    await db.queryAsync(
      `UPDATE appointments
       SET check_in_confirmed = 1,
           checked_in_at = COALESCE(checked_in_at, NOW()),
           updated_at = NOW()
       WHERE id = ?`,
      [appointment.id]
    );

    const averageConsultationMinutes = await getDoctorAverageMinutes(db, appointment.doctor_id);
    const [aheadRow] = await db.queryAsync(
      `SELECT COUNT(*) AS total
       FROM appointments
       WHERE appointment_date = ?
         AND doctor_id = ?
         AND queue_number < ?
         AND status IN ('Waiting', 'In Progress')`,
      [appointment.appointment_date, appointment.doctor_id, appointment.queue_number]
    );

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", {
        appointmentId: appointment.id,
        status: appointment.status,
        check_in_confirmed: 1
      });
      io.emit("patients:updated", {
        appointmentId: appointment.id,
        status: appointment.status,
        check_in_confirmed: 1
      });
    }

    await notifyQueueUpdateForAppointment(db, appointment.id, {
      status: appointment.status,
      queue_number: appointment.queue_number,
      check_in_confirmed: 1
    });

    return res.json({
      success: true,
      message: "Check-in confirmed",
      appointment: {
        id: appointment.id,
        patient_name: appointment.patient_name,
        doctor_name: appointment.doctor_name,
        appointment_date: appointment.appointment_date,
        appointment_time: appointment.appointment_time,
        queue_number: appointment.queue_number,
        status: appointment.status,
        check_in_confirmed: 1,
        estimated_waiting_time_minutes: Number(aheadRow?.total || 0) * averageConsultationMinutes
      }
    });
  } catch (error) {
    console.error("QR check-in error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to check in" });
  }
});

/**
 * GET SINGLE APPOINTMENT
 */
router.get("/:id", authenticate, requireRole("Doctor", "Admin"), (req, res) => {
  const { id } = req.params;

  db.query("SELECT * FROM appointments WHERE id = ?", [id], (err, results) => {
    if (err) {
      return res.status(500).json({ message: "Database error" });
    }
    if (results.length === 0) {
      return res.status(404).json({ message: "Appointment not found" });
    }
    res.json(results[0]);
  });
});

const appointmentUpdateSchema = Joi.object({
  patient_name: Joi.string().min(3).max(100),
  ic_number: Joi.string().min(6).max(30),
  doctor_id: Joi.number().integer(),
  appointment_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/),
  appointment_time: Joi.string().pattern(/^\d{2}:\d{2}$/),
  patient_email: Joi.string().email().allow("", null),
  patient_phone: Joi.string().allow("", null),
  status: Joi.string().valid("Waiting", "In Progress", "Completed", "Cancelled"),
  description: Joi.string().allow("", null)
}).min(1);

router.put("/:id", authenticate, requireRole("Doctor", "Admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { error, value } = appointmentUpdateSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        message: "Validation failed",
        errors: error.details.map((item) => item.message)
      });
    }

    const existingRows = await db.queryAsync(
      `SELECT * FROM appointments WHERE id = ? LIMIT 1`,
      [id]
    );

    if (existingRows.length === 0) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    const current = existingRows[0];
    const nextValues = {
      patient_name: value.patient_name !== undefined ? value.patient_name : current.patient_name,
      ic_number: value.ic_number !== undefined ? value.ic_number : current.ic_number,
      doctor_id: value.doctor_id !== undefined ? value.doctor_id : current.doctor_id,
      appointment_date: value.appointment_date !== undefined ? value.appointment_date : current.appointment_date,
      appointment_time: value.appointment_time !== undefined ? value.appointment_time : String(current.appointment_time).slice(0, 5),
      patient_email: value.patient_email !== undefined ? value.patient_email : current.patient_email,
      patient_phone: value.patient_phone !== undefined ? value.patient_phone : current.patient_phone,
      status: value.status !== undefined ? value.status : current.status,
      description: value.description !== undefined ? value.description : current.description
    };

    const scheduleChanged =
      nextValues.doctor_id !== current.doctor_id ||
      nextValues.appointment_date !== current.appointment_date ||
      nextValues.appointment_time !== String(current.appointment_time).slice(0, 5);

    const dateChanged = nextValues.appointment_date !== current.appointment_date;
    let queueNumber = current.queue_number;
    let checkInToken = current.check_in_token;
    let checkInConfirmed = current.check_in_confirmed;
    let checkedInAt = current.checked_in_at;
    if (dateChanged) {
      queueNumber = await getNextQueueNumber(nextValues.appointment_date);
      checkInToken = String(queueNumber);
      checkInConfirmed = 0;
      checkedInAt = null;
    }

    const availabilityCheck = await validateDoctorAvailability(
      nextValues.doctor_id,
      nextValues.appointment_date,
      nextValues.appointment_time
    );
    if (!availabilityCheck.valid) {
      return res.status(409).json({ message: availabilityCheck.message });
    }

    const conflict = await detectAppointmentConflict({
      doctorId: nextValues.doctor_id,
      appointmentDate: nextValues.appointment_date,
      appointmentTime: nextValues.appointment_time,
      icNumber: nextValues.ic_number,
      excludeId: id
    });
    if (!conflict.ok) {
      return res.status(conflict.status).json({ message: conflict.message });
    }

    const syncedPatient = await upsertPatientFromAppointment(db, nextValues);

    await db.queryAsync(
      `UPDATE appointments
       SET patient_name = ?,
           ic_number = ?,
           patient_email = ?,
           patient_phone = ?,
           doctor_id = ?,
           appointment_date = ?,
           appointment_time = ?,
           queue_number = ?,
           patient_id = ?,
           check_in_token = ?,
           check_in_confirmed = ?,
           checked_in_at = ?,
           status = ?,
           description = ?,
             reminder_notified_at = ?,
             missed_notified_at = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        nextValues.patient_name,
        nextValues.ic_number,
        nextValues.patient_email || syncedPatient.email || null,
        nextValues.patient_phone || syncedPatient.phone || null,
        nextValues.doctor_id,
        nextValues.appointment_date,
        nextValues.appointment_time,
        queueNumber,
        syncedPatient.id,
        checkInToken,
        checkInConfirmed,
        checkedInAt,
        nextValues.status,
        nextValues.description || null,
        scheduleChanged ? null : current.reminder_notified_at,
        scheduleChanged ? null : current.missed_notified_at,
        id
      ]
    );

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", { appointmentId: id, status: nextValues.status });
      io.emit("patients:updated", { appointmentId: id, status: nextValues.status, patientId: syncedPatient.id });
    }

    if (scheduleChanged || nextValues.status !== current.status) {
      await notifyQueueUpdateForAppointment(db, id, {
        status: nextValues.status,
        queue_number: queueNumber,
        doctor_id: nextValues.doctor_id
      });
    }

    return res.json({
      message: "Appointment updated successfully",
      appointment: {
        id,
        patient_name: nextValues.patient_name,
        ic_number: nextValues.ic_number,
        doctor_id: nextValues.doctor_id,
        appointment_date: nextValues.appointment_date,
        appointment_time: nextValues.appointment_time,
        queue_number: queueNumber,
        patient_id: syncedPatient.id,
        status: nextValues.status,
        description: nextValues.description || null
      }
    });
  } catch (error) {
    console.error("Update appointment error:", error.message);
    return res.status(500).json({ message: "Failed to update appointment" });
  }
});

/**
 * UPDATE APPOINTMENT DESCRIPTION
 */
router.put("/:id/description", authenticate, requireRole("Doctor", "Admin"), (req, res) => {
  const { id } = req.params;
  const { description } = req.body;

  db.query(
    "UPDATE appointments SET description = ? WHERE id = ?",
    [description, id],
    (err, result) => {
      if (err) {
        return res.status(500).json({ message: "Database error" });
      }
      res.json({ message: "Description updated successfully" });
    }
  );
});

router.put("/:id/status", authenticate, requireRole("Doctor", "Admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ message: "Status is required" });
    }

    const fields = ["status = ?", "updated_at = NOW()"];
    const params = [status];

    if (status === "In Progress") {
      fields.push("started_at = COALESCE(started_at, NOW())");
      fields.push("check_in_confirmed = 1");
      fields.push("checked_in_at = COALESCE(checked_in_at, NOW())");
    }

    if (status === "Completed") {
      fields.push("completed_at = NOW()");
      fields.push("check_in_confirmed = 1");
    }

    const result = await db.queryAsync(
      `UPDATE appointments SET ${fields.join(", ")} WHERE id = ?`,
      [...params, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", { appointmentId: id, status });
      io.emit("patients:updated", { appointmentId: id, status });
    }

    await notifyQueueUpdateForAppointment(db, id, { status });

    return res.json({ message: "Status updated" });
  } catch (error) {
    console.error("Update status error:", error.message);
    return res.status(500).json({ message: "Failed to update status" });
  }
});

router.delete("/:id", authenticate, requireRole("Admin"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const rows = await db.queryAsync("SELECT id FROM appointments WHERE id = ? LIMIT 1", [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    await db.queryAsync("DELETE FROM notifications WHERE appointment_id = ?", [id]);
    await db.queryAsync("DELETE FROM medical_records WHERE appointment_id = ?", [id]);
    await db.queryAsync("DELETE FROM appointments WHERE id = ?", [id]);

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", { appointmentId: id, deleted: true });
      io.emit("patients:updated", { appointmentId: id, deleted: true });
    }

    return res.json({ message: "Appointment deleted successfully" });
  } catch (error) {
    console.error("Delete appointment error:", error.message);
    return res.status(500).json({ message: "Failed to delete appointment" });
  }
});

router.put("/:id/patient", authenticate, requireRole("Patient"), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { appointment_date, appointment_time, doctor_id, action } = req.body || {};
    const appointmentRows = await db.queryAsync(
      `SELECT * FROM appointments WHERE id = ? LIMIT 1`,
      [id]
    );

    if (appointmentRows.length === 0) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    const appointment = appointmentRows[0];
    const patientId = Number(req.user?.patientId || 0);
    if (!patientId || Number(appointment.patient_id) !== patientId) {
      return res.status(403).json({ message: "Forbidden: not your appointment" });
    }

    if (action === "cancel") {
      await db.queryAsync(
        "UPDATE appointments SET status = 'Cancelled', updated_at = NOW() WHERE id = ?",
        [id]
      );

      const io = req.app.get("io");
      if (io) {
        io.emit("queue:updated", { appointmentId: id, status: "Cancelled" });
        io.emit("patients:updated", { appointmentId: id, status: "Cancelled", patientId });
      }

      await notifyQueueUpdateForAppointment(db, id, { status: "Cancelled" });

      return res.json({ message: "Appointment cancelled successfully" });
    }

    if (!appointment_date || !appointment_time || !doctor_id) {
      return res.status(400).json({ message: "doctor_id, appointment_date and appointment_time are required to reschedule" });
    }

    const availabilityCheck = await validateDoctorAvailability(doctor_id, appointment_date, appointment_time);
    if (!availabilityCheck.valid) {
      return res.status(409).json({ message: availabilityCheck.message });
    }

    const conflict = await detectAppointmentConflict({
      doctorId: Number(doctor_id),
      appointmentDate: appointment_date,
      appointmentTime: appointment_time,
      icNumber: appointment.ic_number,
      excludeId: id
    });
    if (!conflict.ok) {
      return res.status(conflict.status).json({ message: conflict.message });
    }

    const queueNumber = appointment_date !== appointment.appointment_date
      ? await getNextQueueNumber(appointment_date)
      : appointment.queue_number;

    await db.queryAsync(
      `UPDATE appointments
       SET doctor_id = ?,
           appointment_date = ?,
           appointment_time = ?,
           queue_number = ?,
           check_in_token = ?,
           check_in_confirmed = 0,
           checked_in_at = NULL,
             reminder_notified_at = NULL,
             missed_notified_at = NULL,
           status = 'Waiting',
           updated_at = NOW()
       WHERE id = ?`,
      [Number(doctor_id), appointment_date, appointment_time, queueNumber, String(queueNumber), id]
    );

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", { appointmentId: id, status: "Waiting" });
      io.emit("patients:updated", { appointmentId: id, status: "Waiting", patientId });
    }

    await notifyQueueUpdateForAppointment(db, id, {
      status: "Waiting",
      queue_number: queueNumber,
      doctor_id: Number(doctor_id)
    });

    return res.json({ message: "Appointment rescheduled successfully" });
  } catch (error) {
    console.error("Patient appointment update error:", error.message);
    return res.status(500).json({ message: "Failed to update appointment" });
  }
});

module.exports = router;
