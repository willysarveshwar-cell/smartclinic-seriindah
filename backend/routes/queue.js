const express = require("express");
const router = express.Router();
const db = require("../db");
const { estimateQueueByDoctor } = require("../utils/waitEstimator");
const { notifyQueueUpdateForAppointment }   = require("../services/notificationService");
const { authenticate, requireRole } = require("../middleware/auth");

router.use(authenticate, requireRole("Doctor", "Admin"));

function todayDate() {
  return new Date().toISOString().split("T")[0];
}

/**
 * ================================
 * GET TODAY'S LIVE QUEUE
 * - Used by Admin & Nurse Queue Page
 * - Displays patient & doctor details
 * ================================
 */
router.get("/", (req, res) => {
  const today = todayDate();
  const { doctor_id, status, search } = req.query;

  const conditions = ["a.appointment_date = ?"];
  const params = [today];

  if (doctor_id) {
    conditions.push("a.doctor_id = ?");
    params.push(Number(doctor_id));
  }

  if (status) {
    conditions.push("a.status = ?");
    params.push(status);
  }

  if (search) {
    conditions.push("(LOWER(a.patient_name) LIKE ? OR a.ic_number LIKE ?)");
    params.push(`%${String(search).toLowerCase()}%`, `%${search}%`);
  }

  const whereSql = `WHERE ${conditions.join(" AND ")}`;

  const query = `
    SELECT 
      a.id,
      a.queue_number,
      a.patient_name,
      a.ic_number,
      a.doctor_id,
      a.status,
      a.appointment_time,
      a.started_at,
      a.check_in_confirmed,
      a.checked_in_at,
      d.name AS doctor_name,
      d.avg_consultation_minutes
    FROM appointments a
    LEFT JOIN doctors d ON a.doctor_id = d.id
    ${whereSql}
    ORDER BY a.queue_number ASC
  `;

  db.query(query, params, async (err, results) => {
    if (err) {
      console.error("Fetch queue error:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to load queue"
      });
    }

    try {
      const estimated = await estimateQueueByDoctor(db, results);
      res.json(estimated);
    } catch (estimateError) {
      console.error("Queue estimate error:", estimateError.message);
      res.json(results);
    }
  });
});

router.post("/next", async (req, res) => {
  try {
    const today = todayDate();
    const doctorId = req.body?.doctor_id ? Number(req.body.doctor_id) : null;

    const inProgressConditions = ["appointment_date = ?", "status = 'In Progress'"];
    const inProgressParams = [today];

    if (doctorId) {
      inProgressConditions.push("doctor_id = ?");
      inProgressParams.push(doctorId);
    }

    const inProgressRows = await db.queryAsync(
      `SELECT id, queue_number, doctor_id
       FROM appointments
       WHERE ${inProgressConditions.join(" AND ")}
       ORDER BY queue_number ASC
       LIMIT 1`,
      inProgressParams
    );

    if (inProgressRows.length > 0) {
      return res.status(409).json({
        message: "A patient is already in progress. Complete or skip that patient first.",
        appointmentId: inProgressRows[0].id
      });
    }

    const waitingConditions = ["appointment_date = ?", "status = 'Waiting'"];
    const waitingParams = [today];
    if (doctorId) {
      waitingConditions.push("doctor_id = ?");
      waitingParams.push(doctorId);
    }

    const waitingRows = await db.queryAsync(
      `SELECT id, queue_number, doctor_id, patient_name
       FROM appointments
       WHERE ${waitingConditions.join(" AND ")}
       ORDER BY queue_number ASC
       LIMIT 1`,
      waitingParams
    );

    if (waitingRows.length === 0) {
      return res.status(404).json({ message: "No waiting patients in queue" });
    }

    const next = waitingRows[0];

    await db.queryAsync(
      `UPDATE appointments
       SET status = 'In Progress',
           started_at = COALESCE(started_at, NOW()),
           check_in_confirmed = 1,
           checked_in_at = COALESCE(checked_in_at, NOW()),
           updated_at = NOW()
       WHERE id = ?`,
      [next.id]
    );

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", { appointmentId: next.id, status: "In Progress" });
      io.emit("patients:updated", { appointmentId: next.id, status: "In Progress" });
    }

    await notifyQueueUpdateForAppointment(db, next.id, {
      status: "In Progress",
      queue_number: next.queue_number,
      doctor_id: next.doctor_id
    });

    return res.json({
      message: "Next patient called",
      appointmentId: next.id,
      patientName: next.patient_name,
      queueNumber: next.queue_number,
      doctorId: next.doctor_id
    });
  } catch (error) {
    console.error("Queue call-next error:", error.message);
    return res.status(500).json({ message: "Failed to call next patient" });
  }
});

router.put("/:id/skip", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const appointmentRows = await db.queryAsync(
      `SELECT id, doctor_id, appointment_date, status
       FROM appointments
       WHERE id = ?
       LIMIT 1`,
      [id]
    );

    if (appointmentRows.length === 0) {
      return res.status(404).json({ message: "Queue entry not found" });
    }

    const appointment = appointmentRows[0];
    if (appointment.status !== "In Progress" && appointment.status !== "Waiting") {
      return res.status(409).json({ message: `Cannot skip patient with status ${appointment.status}` });
    }

    const [maxRow] = await db.queryAsync(
      `SELECT COALESCE(MAX(queue_number), 0) AS max_queue
       FROM appointments
       WHERE appointment_date = ?
         AND doctor_id = ?
         AND status IN ('Waiting', 'In Progress')`,
      [appointment.appointment_date, appointment.doctor_id]
    );

    const nextQueueNumber = Number(maxRow?.max_queue || 0) + 1;

    await db.queryAsync(
      `UPDATE appointments
       SET status = 'Waiting',
           queue_number = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [nextQueueNumber, id]
    );

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", { appointmentId: id, status: "Waiting", skipped: true });
      io.emit("patients:updated", { appointmentId: id, status: "Waiting", skipped: true });
    }

    await notifyQueueUpdateForAppointment(db, id, {
      status: "Waiting",
      queue_number: nextQueueNumber,
      doctor_id: appointment.doctor_id,
      skipped: true
    });

    return res.json({ message: "Patient skipped and moved to end of queue", queueNumber: nextQueueNumber });
  } catch (error) {
    console.error("Queue skip error:", error.message);
    return res.status(500).json({ message: "Failed to skip patient" });
  }
});

router.put("/:id/transfer", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const targetDoctorId = Number(req.body?.target_doctor_id);

    if (!Number.isInteger(targetDoctorId) || targetDoctorId <= 0) {
      return res.status(400).json({ message: "target_doctor_id is required" });
    }

    const appointmentRows = await db.queryAsync(
      `SELECT id, doctor_id, appointment_date, status
       FROM appointments
       WHERE id = ?
       LIMIT 1`,
      [id]
    );

    if (appointmentRows.length === 0) {
      return res.status(404).json({ message: "Queue entry not found" });
    }

    const appointment = appointmentRows[0];
    if (appointment.status === "Completed" || appointment.status === "Cancelled") {
      return res.status(409).json({ message: `Cannot transfer patient with status ${appointment.status}` });
    }

    const doctorRows = await db.queryAsync("SELECT id FROM doctors WHERE id = ? LIMIT 1", [targetDoctorId]);
    if (doctorRows.length === 0) {
      return res.status(404).json({ message: "Target doctor not found" });
    }

    const [maxRow] = await db.queryAsync(
      `SELECT COALESCE(MAX(queue_number), 0) AS max_queue
       FROM appointments
       WHERE appointment_date = ?
         AND doctor_id = ?
         AND status IN ('Waiting', 'In Progress')`,
      [appointment.appointment_date, targetDoctorId]
    );
    const nextQueueNumber = Number(maxRow?.max_queue || 0) + 1;

    await db.queryAsync(
      `UPDATE appointments
       SET doctor_id = ?,
           queue_number = ?,
           status = 'Waiting',
           started_at = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [targetDoctorId, nextQueueNumber, id]
    );

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", {
        appointmentId: id,
        status: "Waiting",
        transferred: true,
        targetDoctorId
      });
      io.emit("patients:updated", {
        appointmentId: id,
        status: "Waiting",
        transferred: true,
        targetDoctorId
      });
    }

    await notifyQueueUpdateForAppointment(db, id, {
      status: "Waiting",
      queue_number: nextQueueNumber,
      doctor_id: targetDoctorId,
      transferred: true,
      target_doctor_id: targetDoctorId
    });

    return res.json({
      message: "Patient transferred successfully",
      appointmentId: id,
      targetDoctorId,
      queueNumber: nextQueueNumber
    });
  } catch (error) {
    console.error("Queue transfer error:", error.message);
    return res.status(500).json({ message: "Failed to transfer patient" });
  }
});

router.put("/:id/status", async (req, res) => {
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
    }

    if (status === "Completed") {
      fields.push("completed_at = NOW()");
      fields.push("check_in_confirmed = 1");
    }

    params.push(id);

    const result = await db.queryAsync(
      `UPDATE appointments SET ${fields.join(", ")} WHERE id = ?`,
      params
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Queue entry not found" });
    }

    const io = req.app.get("io");
    if (io) {
      io.emit("queue:updated", { appointmentId: id, status });
      io.emit("patients:updated", { appointmentId: id, status });
    }

    await notifyQueueUpdateForAppointment(db, id, { status });

    return res.json({ message: "Queue status updated" });
  } catch (error) {
    console.error("Queue status update error:", error.message);
    return res.status(500).json({ message: "Failed to update queue status" });
  }
});

module.exports = router;
