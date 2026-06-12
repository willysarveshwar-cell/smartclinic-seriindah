const MIN_AVG_MINUTES = 5;
const MAX_AVG_MINUTES = 45;
const DEFAULT_AVG_MINUTES = 15;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toMinutes(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

async function getDoctorAverageMinutes(db, doctorId) {
  const durationRows = await db.queryAsync(
    `SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at))/60) AS avg_minutes
     FROM appointments
     WHERE doctor_id = ?
       AND status = 'Completed'
       AND started_at IS NOT NULL
       AND completed_at IS NOT NULL`,
    [doctorId]
  );

  const historicalAvg = toMinutes(durationRows[0]?.avg_minutes);
  if (historicalAvg !== null) {
    return clamp(Math.round(historicalAvg), MIN_AVG_MINUTES, MAX_AVG_MINUTES);
  }

  const doctorRows = await db.queryAsync(
    "SELECT avg_consultation_minutes FROM doctors WHERE id = ? LIMIT 1",
    [doctorId]
  );

  const configuredAvg = toMinutes(doctorRows[0]?.avg_consultation_minutes);
  if (configuredAvg !== null) {
    return clamp(Math.round(configuredAvg), MIN_AVG_MINUTES, MAX_AVG_MINUTES);
  }

  return DEFAULT_AVG_MINUTES;
}

function computeRemainingForInProgress(appointment, avgMinutes) {
  if (!appointment.started_at) {
    return avgMinutes;
  }

  // MySQL DATETIME comes back as "YYYY-MM-DD HH:MM:SS"; convert to ISO for reliable parsing
  const startedAtMs = Date.parse(String(appointment.started_at).replace(" ", "T"));
  if (Number.isNaN(startedAtMs)) {
    return avgMinutes;
  }

  const elapsedMinutes = (Date.now() - startedAtMs) / 60000;
  return Math.max(0, Math.round(avgMinutes - elapsedMinutes));
}

async function estimateQueueByDoctor(db, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return rows || [];
  }

  const grouped = new Map();
  rows.forEach((row) => {
    const doctorId = Number(row.doctor_id);
    if (!grouped.has(doctorId)) grouped.set(doctorId, []);
    grouped.get(doctorId).push(row);
  });

  for (const [doctorId, doctorRows] of grouped.entries()) {
    const avgMinutes = await getDoctorAverageMinutes(db, doctorId);

    const activeQueue = doctorRows
      .filter((r) => r.status === "Waiting" || r.status === "In Progress")
      .sort((a, b) => Number(a.queue_number) - Number(b.queue_number));

    const inProgress = activeQueue.find((r) => r.status === "In Progress") || null;

    doctorRows.forEach((row) => {
      row.doctor_average_consultation_minutes = avgMinutes;

      if (row.status === "Completed" || row.status === "Cancelled") {
        row.estimated_waiting_time_minutes = 0;
        return;
      }

      if (row.status === "In Progress") {
        row.estimated_waiting_time_minutes = computeRemainingForInProgress(row, avgMinutes);
        return;
      }

      const ahead = activeQueue.filter((q) => Number(q.queue_number) < Number(row.queue_number));
      let estimate = ahead.length * avgMinutes;

      if (inProgress && ahead.some((q) => Number(q.id) === Number(inProgress.id))) {
        estimate -= avgMinutes;
        estimate += computeRemainingForInProgress(inProgress, avgMinutes);
      }

      row.estimated_waiting_time_minutes = Math.max(0, Math.round(estimate));
    });
  }

  return rows;
}

function listWaitEstimatorMethods() {
  return [
    "getDoctorAverageMinutes",
    "estimateQueueByDoctor"
  ];
}

module.exports = {
  getDoctorAverageMinutes,
  estimateQueueByDoctor,
  listWaitEstimatorMethods
};
