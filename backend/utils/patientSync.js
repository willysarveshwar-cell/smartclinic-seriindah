const { hashPassword } = require("./security");

function normalize(value) {
  return String(value || "").trim();
}

function normalizeEmail(email) {
  return normalize(email).toLowerCase();
}

function fallbackEmailFromIc(icNumber) {
  const safe = normalize(icNumber).replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "unknown";
  return `walkin_${safe}@smartclinic.local`;
}

async function ensurePatientUser(db, patient) {
  const userRows = await db.queryAsync(
    `SELECT userId
     FROM users
     WHERE role = 'Patient' AND (linked_patient_id = ? OR LOWER(email) = ?)
     LIMIT 1`,
    [patient.id, normalizeEmail(patient.email)]
  );

  if (userRows.length > 0) {
    await db.queryAsync(
      `UPDATE users
       SET fullName = ?,
           email = ?,
           linked_patient_id = ?
       WHERE userId = ?`,
      [patient.full_name, patient.email, patient.id, userRows[0].userId]
    );
    return;
  }

  await db.queryAsync(
    `INSERT IGNORE INTO users (fullName, email, password, role, linked_patient_id, email_verified)
     VALUES (?, ?, ?, 'Patient', ?, 1)`,
    [patient.full_name, patient.email, patient.password, patient.id]
  );
}

async function upsertPatientFromAppointment(db, payload) {
  const icNumber = normalize(payload.ic_number);
  const fullName = normalize(payload.patient_name) || "Walk-in Patient";
  const phone = normalize(payload.patient_phone) || null;
  const inputEmail = normalizeEmail(payload.patient_email);

  if (!icNumber) {
    throw new Error("ic_number is required to synchronize patient");
  }

  const resolvedEmail = inputEmail || fallbackEmailFromIc(icNumber);

  let existing = await db.queryAsync(
    `SELECT id, full_name, email, phone, ic_number, password
     FROM patients
     WHERE ic_number = ?
     LIMIT 1`,
    [icNumber]
  );

  if (existing.length === 0 && inputEmail) {
    existing = await db.queryAsync(
      `SELECT id, full_name, email, phone, ic_number, password
       FROM patients
       WHERE LOWER(email) = ?
       LIMIT 1`,
      [inputEmail]
    );
  }

  if (existing.length > 0) {
    const patient = existing[0];

    const updates = [];
    const params = [];

    if (fullName && fullName !== patient.full_name) {
      updates.push("full_name = ?");
      params.push(fullName);
    }

    if (phone && phone !== patient.phone) {
      updates.push("phone = ?");
      params.push(phone);
    }

    if (inputEmail && inputEmail !== patient.email) {
      const emailConflict = await db.queryAsync(
        "SELECT id FROM patients WHERE LOWER(email) = ? AND id != ? LIMIT 1",
        [inputEmail, patient.id]
      );
      if (emailConflict.length === 0) {
        updates.push("email = ?");
        params.push(inputEmail);
      }
    }

    if (updates.length > 0) {
      params.push(patient.id);
      await db.queryAsync(`UPDATE patients SET ${updates.join(", ")} WHERE id = ?`, params);
    }

    const refreshedRows = await db.queryAsync(
      "SELECT id, full_name, email, phone, ic_number, password FROM patients WHERE id = ? LIMIT 1",
      [patient.id]
    );
    const refreshed = refreshedRows[0];

    await ensurePatientUser(db, refreshed);
    return refreshed;
  }

  const autoPassword = await hashPassword(`AutoPatient-${icNumber}`);

  const insert = await db.queryAsync(
    `INSERT INTO patients (full_name, email, phone, ic_number, password)
     VALUES (?, ?, ?, ?, ?)`,
    [fullName, resolvedEmail, phone, icNumber, autoPassword]
  );

  const createdRows = await db.queryAsync(
    "SELECT id, full_name, email, phone, ic_number, password FROM patients WHERE id = ? LIMIT 1",
    [insert.insertId]
  );
  const created = createdRows[0];

  await ensurePatientUser(db, created);
  return created;
}

async function syncLegacyAppointmentPatients(db) {
  const pendingAppointments = await db.queryAsync(
    `SELECT id, patient_name, ic_number, patient_email, patient_phone
     FROM appointments
     WHERE patient_id IS NULL
     ORDER BY id ASC
     LIMIT 300`
  );

  for (const appointment of pendingAppointments) {
    try {
      const patient = await upsertPatientFromAppointment(db, appointment);
      await db.queryAsync("UPDATE appointments SET patient_id = ? WHERE id = ?", [patient.id, appointment.id]);
    } catch (error) {
      console.error("Legacy appointment-patient sync failed:", error.message);
    }
  }
}

module.exports = {
  upsertPatientFromAppointment,
  syncLegacyAppointmentPatients
};
