const pool = require('../config/database');

// Get all welfare contributions
const getAllWelfareContributions = async (req, res) => {
  try {
    const [contributions] = await pool.execute(
      `SELECT w.*, m.full_name as member_name
       FROM welfare_contributions w
       JOIN members m ON w.member_id = m.id
       ORDER BY w.created_at DESC`
    );
    res.json({ contributions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch welfare contributions.' });
  }
};

// Record welfare contribution
const recordWelfareContribution = async (req, res) => {
  try {
    const { member_id, amount, payment_method, reference_number, remarks } = req.body;

    const [result] = await pool.execute(
      `INSERT INTO welfare_contributions (member_id, amount, contribution_date, payment_method, reference_number, status, remarks)
       VALUES (?, ?, CURDATE(), ?, ?, 'confirmed', ?)`,
      [member_id, amount, payment_method || 'cash', reference_number || null, remarks || null]
    );

    res.status(201).json({ success: true, contribution_id: result.insertId, message: 'Welfare contribution recorded.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to record welfare contribution.' });
  }
};

// Get welfare requests
const getWelfareRequests = async (req, res) => {
  try {
    const [requests] = await pool.execute(
      `SELECT w.*, m.full_name as member_name, a.full_name as approved_by_name
       FROM welfare_requests w
       JOIN members m ON w.member_id = m.id
       LEFT JOIN admins a ON w.approved_by = a.id
       ORDER BY w.created_at DESC`
    );
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch welfare requests.' });
  }
};

// Submit welfare request
const submitWelfareRequest = async (req, res) => {
  try {
    const { amount, reason } = req.body;
    const memberId = req.user.id;

    const [result] = await pool.execute(
      `INSERT INTO welfare_requests (member_id, amount, reason, request_date)
       VALUES (?, ?, ?, CURDATE())`,
      [memberId, amount, reason]
    );

    res.status(201).json({ success: true, request_id: result.insertId, message: 'Welfare request submitted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to submit welfare request.' });
  }
};

// Approve welfare request
const approveWelfareRequest = async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute(
      `UPDATE welfare_requests SET status = 'approved', approved_by = ?, approval_date = CURDATE() WHERE id = ?`,
      [req.user.id, id]
    );

    res.json({ success: true, message: 'Welfare request approved.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to approve welfare request.' });
  }
};

// Reject welfare request
const rejectWelfareRequest = async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute(
      `UPDATE welfare_requests SET status = 'rejected', approved_by = ?, approval_date = CURDATE() WHERE id = ?`,
      [req.user.id, id]
    );

    res.json({ success: true, message: 'Welfare request rejected.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to reject welfare request.' });
  }
};

module.exports = {
  getAllWelfareContributions,
  recordWelfareContribution,
  getWelfareRequests,
  submitWelfareRequest,
  approveWelfareRequest,
  rejectWelfareRequest
};
