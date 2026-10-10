const pool = require('../config/database');

// Get all contributions
const getAllContributions = async (req, res) => {
  try {
    const [contributions] = await pool.execute(
      `SELECT c.*, m.full_name as member_name, a.full_name as recorded_by_name
       FROM contributions c
       JOIN members m ON c.member_id = m.id
       LEFT JOIN admins a ON c.recorded_by = a.id
       ORDER BY c.created_at DESC`
    );
    res.json({ contributions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contributions.' });
  }
};

// Record contribution
const recordContribution = async (req, res) => {
  try {
    const { member_id, amount, contribution_date, payment_method, reference_number, remarks } = req.body;

    if (!member_id || !amount || !contribution_date) {
      return res.status(400).json({ error: 'Member, amount, and date are required.' });
    }

    const [result] = await pool.execute(
      `INSERT INTO contributions (member_id, amount, contribution_date, payment_method, reference_number, status, remarks, recorded_by)
       VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)`,
      [member_id, amount, contribution_date, payment_method || 'cash', reference_number || null, remarks || null, req.user.id]
    );

    res.status(201).json({ success: true, contribution_id: result.insertId, message: 'Contribution recorded successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to record contribution.' });
  }
};

// Get contributions by member
const getMemberContributions = async (req, res) => {
  try {
    const { member_id } = req.params;
    const [contributions] = await pool.execute(
      'SELECT * FROM contributions WHERE member_id = ? ORDER BY contribution_date DESC',
      [member_id]
    );
    res.json({ contributions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch contributions.' });
  }
};

// Get contribution summary
const getContributionSummary = async (req, res) => {
  try {
    const [summary] = await pool.execute(
      `SELECT
        COUNT(*) as total_contributions,
        COALESCE(SUM(amount), 0) as total_amount,
        COALESCE(AVG(amount), 0) as average_amount,
        COUNT(DISTINCT member_id) as contributing_members
       FROM contributions WHERE status = 'confirmed'`
    );

    const [monthly] = await pool.execute(
      `SELECT DATE_FORMAT(contribution_date, '%Y-%m') as month, COALESCE(SUM(amount), 0) as total
       FROM contributions WHERE status = 'confirmed'
       GROUP BY DATE_FORMAT(contribution_date, '%Y-%m')
       ORDER BY month DESC LIMIT 12`
    );

    res.json({ summary: summary[0], monthly });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch summary.' });
  }
};

module.exports = {
  getAllContributions,
  recordContribution,
  getMemberContributions,
  getContributionSummary
};
