const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();

// Ensure leave_type column exists
(async () => {
  try {
    await db.queryAsync(
      "ALTER TABLE doctor_leaves ADD COLUMN IF NOT EXISTS leave_type VARCHAR(50) DEFAULT 'Annual Leave'"
    );
  } catch (e) {
    // ignore
  }
})();

// GET /api/leaves - All leaves with stats (Admin only)
router.get('/', authenticate, requireRole('Admin'), async (req, res) => {
  try {
    const { status, type, doctor } = req.query;

    const conditions = [];
    const params = [];

    if (status) {
      conditions.push('dl.status = ?');
      params.push(status);
    }
    if (type) {
      conditions.push('dl.leave_type ILIKE ?');
      params.push(`%${type}%`);
    }
    if (doctor) {
      conditions.push("(d.name ILIKE ? OR CAST(dl.doctor_id AS TEXT) = ?)");
      params.push(`%${doctor}%`, String(doctor));
    }

    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const leaves = await db.queryAsync(
      `SELECT dl.id AS "leaveId",
              d.name AS "doctorName",
              COALESCE(dl.leave_type, 'Annual Leave') AS "leaveType",
              TO_CHAR(dl.start_date, 'YYYY-MM-DD') AS "fromDate",
              TO_CHAR(dl.end_date, 'YYYY-MM-DD') AS "toDate",
              (dl.end_date - dl.start_date + 1) AS "numberOfDays",
              dl.status,
              dl.reason
       FROM doctor_leaves dl
       JOIN doctors d ON d.id = dl.doctor_id
       ${where}
       ORDER BY dl.created_at DESC`,
      params
    );

    const statsRows = await db.queryAsync(
      'SELECT status, COUNT(*) AS count FROM doctor_leaves GROUP BY status'
    );

    const stats = { total: 0, pending: 0, approved: 0, rejected: 0 };
    statsRows.forEach(r => {
      const cnt = parseInt(r.count, 10);
      stats.total += cnt;
      const key = String(r.status || '').toLowerCase();
      if (Object.prototype.hasOwnProperty.call(stats, key)) {
        stats[key] = cnt;
      }
    });

    return res.json({ stats, leaves });
  } catch (error) {
    console.error('Get all leaves error:', error.message);
    return res.status(500).json({ message: 'Failed to load leaves' });
  }
});

// POST /api/leaves - Admin creates a leave (auto-approved)
router.post('/', authenticate, requireRole('Admin'), async (req, res) => {
  try {
    const { doctorId, leaveType, fromDate, toDate, reason } = req.body || {};

    if (!doctorId || !fromDate || !toDate) {
      return res.status(400).json({ message: 'doctorId, fromDate, and toDate are required' });
    }

    if (fromDate > toDate) {
      return res.status(400).json({ message: 'End date must be after start date' });
    }

    const docRows = await db.queryAsync(
      'SELECT id FROM doctors WHERE id = ? LIMIT 1',
      [doctorId]
    );
    if (docRows.length === 0) {
      return res.status(404).json({ message: 'Doctor not found' });
    }

    const overlap = await db.queryAsync(
      `SELECT id FROM doctor_leaves
       WHERE doctor_id = ? AND status IN ('Pending', 'Approved')
         AND NOT (end_date < ? OR start_date > ?)
       LIMIT 1`,
      [doctorId, fromDate, toDate]
    );

    if (overlap.length > 0) {
      return res.status(409).json({ message: 'Leave overlaps with an existing request' });
    }

    const result = await db.queryAsync(
      `INSERT INTO doctor_leaves
         (doctor_id, leave_type, start_date, end_date, reason, status, requested_by_user_id, reviewed_by_user_id, reviewed_at)
       VALUES (?, ?, ?, ?, ?, 'Approved', ?, ?, NOW())`,
      [doctorId, leaveType || 'Annual Leave', fromDate, toDate, reason || null, req.user.id, req.user.id]
    );

    return res.status(201).json({ message: 'Leave submitted and approved', leaveId: result.insertId });
  } catch (error) {
    console.error('Create leave error:', error.message);
    return res.status(500).json({ message: 'Failed to submit leave request' });
  }
});

// POST /api/leaves/:id/approve
router.post('/:id/approve', authenticate, requireRole('Admin'), async (req, res) => {
  try {
    const leaveId = parseInt(req.params.id, 10);

    const rows = await db.queryAsync(
      'SELECT id, doctor_id, start_date, end_date, status FROM doctor_leaves WHERE id = ? LIMIT 1',
      [leaveId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    if (rows[0].status === 'Approved') {
      return res.json({ message: 'Leave already approved' });
    }

    const conflict = await db.queryAsync(
      `SELECT id FROM appointments
       WHERE doctor_id = ? AND appointment_date BETWEEN ? AND ?
         AND status IN ('Waiting', 'In Progress')
       LIMIT 1`,
      [rows[0].doctor_id, rows[0].start_date, rows[0].end_date]
    );

    if (conflict.length > 0) {
      return res.status(409).json({ message: 'Cannot approve: active appointments exist during this period' });
    }

    await db.queryAsync(
      "UPDATE doctor_leaves SET status = 'Approved', reviewed_by_user_id = ?, reviewed_at = NOW() WHERE id = ?",
      [req.user.id, leaveId]
    );

    return res.json({ message: 'Leave approved successfully' });
  } catch (error) {
    console.error('Approve leave error:', error.message);
    return res.status(500).json({ message: 'Failed to approve leave' });
  }
});

// POST /api/leaves/:id/reject
router.post('/:id/reject', authenticate, requireRole('Admin'), async (req, res) => {
  try {
    const leaveId = parseInt(req.params.id, 10);
    const { reason } = req.body || {};

    const rows = await db.queryAsync(
      'SELECT id, status FROM doctor_leaves WHERE id = ? LIMIT 1',
      [leaveId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Leave request not found' });
    }

    if (rows[0].status === 'Rejected') {
      return res.json({ message: 'Leave already rejected' });
    }

    await db.queryAsync(
      "UPDATE doctor_leaves SET status = 'Rejected', review_notes = ?, reviewed_by_user_id = ?, reviewed_at = NOW() WHERE id = ?",
      [reason || null, req.user.id, leaveId]
    );

    return res.json({ message: 'Leave rejected successfully' });
  } catch (error) {
    console.error('Reject leave error:', error.message);
    return res.status(500).json({ message: 'Failed to reject leave' });
  }
});

module.exports = router;
