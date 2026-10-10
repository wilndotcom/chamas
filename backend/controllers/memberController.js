const bcrypt = require('bcryptjs');
const pool = require('../config/database');
const { decorateLoan, summarise } = require('../utils/loanMath');

// Get all members
const getAllMembers = async (req, res) => {
  try {
    const [members] = await pool.execute(
      `SELECT m.*,
        (SELECT COALESCE(SUM(amount), 0) FROM contributions WHERE member_id = m.id AND status = 'confirmed') as total_contributions,
        (SELECT COALESCE(SUM(balance), 0) FROM loans WHERE member_id = m.id AND status IN ('active', 'disbursed')) as loan_balance
       FROM members m ORDER BY m.created_at DESC`
    );

    // Tell the list up front which members are protected by financial history,
    // so the UI can explain it rather than letting the admin hit an error.
    const history = await countHistoryFor(members.map((m) => m.id));

    const withHistory = members.map((m) => {
      const counts = history[String(m.id)] || {};
      const blockers = describeBlockers(counts);
      return { ...m, history_counts: counts, history_blockers: blockers, can_delete: blockers.length === 0 };
    });

    res.json({ members: withHistory });
  } catch (error) {
    console.error('Get members failed:', error);
    res.status(500).json({ error: 'Failed to fetch members.' });
  }
};

// Get single member
const getMember = async (req, res) => {
  try {
    const { id } = req.params;
    const [members] = await pool.execute('SELECT * FROM members WHERE id = ?', [id]);

    if (members.length === 0) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    // Get contribution history
    const [contributions] = await pool.execute(
      'SELECT * FROM contributions WHERE member_id = ? ORDER BY contribution_date DESC LIMIT 10',
      [id]
    );

    // Get loan history
    const [loans] = await pool.execute(
      'SELECT * FROM loans WHERE member_id = ? ORDER BY application_date DESC LIMIT 10',
      [id]
    );

    res.json({ member: members[0], contributions, loans });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch member.' });
  }
};

// Create member
const createMember = async (req, res) => {
  try {
    const { full_name, email, phone, id_number, password, emergency_contact_name, emergency_contact_phone } = req.body;

    if (!full_name || !phone || !password) {
      return res.status(400).json({ error: 'Full name, phone, and password are required.' });
    }

    // Check if phone exists
    const [existing] = await pool.execute('SELECT id FROM members WHERE phone = ?', [phone]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Phone number already registered.' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    // Added directly by an admin, so it is active immediately. The table default
    // is 'pending' because self-registrations must be reviewed.
    const [result] = await pool.execute(
      `INSERT INTO members (full_name, email, phone, id_number, password_hash, status,
        emergency_contact_name, emergency_contact_phone, joined_date)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, CURDATE())`,
      [full_name, email || null, phone, id_number || null, hashedPassword, emergency_contact_name || null, emergency_contact_phone || null]
    );

    res.status(201).json({ success: true, member_id: result.insertId, message: 'Member created successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create member.' });
  }
};

// Update member
const updateMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, phone, id_number, status, emergency_contact_name, emergency_contact_phone } = req.body;

    await pool.execute(
      `UPDATE members SET full_name = ?, email = ?, phone = ?, id_number = ?, status = ?,
       emergency_contact_name = ?, emergency_contact_phone = ? WHERE id = ?`,
      [full_name, email, phone, id_number, status, emergency_contact_name, emergency_contact_phone, id]
    );

    res.json({ success: true, message: 'Member updated successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update member.' });
  }
};

/**
 * Tables whose rows carry financial or audit meaning for a member.
 *
 * These are why a member with history cannot simply be deleted. Contributions
 * are trust money and loan balances are receivables, so cascading a delete
 * through them would silently rewrite every past report and could erase a debt
 * that is still owed.
 *
 * `notifications` is deliberately absent: it holds no money, so it is cleared
 * automatically on delete rather than blocking the operation.
 */
const HISTORY_TABLES = [
  { table: 'contributions', label: 'contribution', plural: 'contributions' },
  { table: 'loans', label: 'loan', plural: 'loans' },
  { table: 'loan_repayments', label: 'loan repayment', plural: 'loan repayments' },
  { table: 'welfare_contributions', label: 'welfare contribution', plural: 'welfare contributions' },
  { table: 'welfare_requests', label: 'welfare request', plural: 'welfare requests' },
  { table: 'ledger_entries', label: 'ledger entry', plural: 'ledger entries' },
  { table: 'audit_logs', label: 'audit log entry', plural: 'audit log entries' }
];

/**
 * Counts linked rows in every history table, in one query.
 *
 * `ids` may be a single member or the whole list, so the members screen can show
 * who is protected by history without an extra request per row. UNION ALL keeps
 * it to one round trip; each COUNT(*) rides an indexed foreign key.
 */
const countHistoryFor = async (ids) => {
  const list = Array.isArray(ids) ? ids : [ids];
  const byMember = {};

  if (list.length === 0) return byMember;

  // Build (src, member_id, n) rows for every table, then fold them in JS.
  const selects = [];
  const params = [];
  for (const t of HISTORY_TABLES) {
    for (const id of list) {
      selects.push(`SELECT '${t.table}' AS src, ? AS member_id, COUNT(*) AS n FROM ${t.table} WHERE member_id = ?`);
      params.push(id, id);
    }
  }

  const [rows] = await pool.execute(
    `SELECT src, member_id, n FROM (${selects.join(' UNION ALL ')}) AS counts WHERE n > 0`,
    params
  );

  for (const r of rows) {
    const key = String(r.member_id);
    if (!byMember[key]) byMember[key] = {};
    byMember[key][r.src] = Number(r.n);
  }
  return byMember;
};

/** Human sentence naming what blocks a delete, e.g. "3 contributions, 1 loan". */
const describeBlockers = (counts) =>
  HISTORY_TABLES.filter((t) => counts && counts[t.table] > 0).map(
    (t) => `${counts[t.table]} ${counts[t.table] === 1 ? t.label : t.plural}`
  );

// Delete member
const deleteMember = async (req, res) => {
  try {
    const { id } = req.params;

    const [existing] = await pool.execute('SELECT id, full_name FROM members WHERE id = ?', [id]);
    if (existing.length === 0) {
      // Previously this reported success while deleting nothing.
      return res.status(404).json({ error: 'Member not found.' });
    }

    const counts = (await countHistoryFor(id))[String(id)] || {};
    const blockers = describeBlockers(counts);

    if (blockers.length > 0) {
      // Refuse rather than cascade. The fix is deactivation, which keeps the
      // ledger intact and still stops the member signing in.
      return res.status(409).json({
        error:
          `${existing[0].full_name} cannot be deleted because they have ` +
          `${blockers.join(', ')}. Deleting would change your savings records and ` +
          `past reports. Deactivate the member instead - they stop signing in and ` +
          `all history is kept.`,
        reason: 'has_history',
        blockers: blockers,
        counts,
        can_deactivate: true
      });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // No financial history, so clearing notifications is safe and keeps the
      // delete from tripping the last foreign key.
      await conn.execute('DELETE FROM notifications WHERE member_id = ?', [id]);
      const [deleted] = await conn.execute('DELETE FROM members WHERE id = ?', [id]);
      if (deleted.affectedRows === 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'Member not found.' });
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }

    res.json({ success: true, message: `${existing[0].full_name} deleted.` });
  } catch (error) {
    // Safety net: if a linked row exists in a table not listed above, say what
    // actually happened instead of a bare "Failed to delete member."
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      const m = /CONSTRAINT `([^`]+)`/.exec(error.sqlMessage || '');
      return res.status(409).json({
        error:
          'This member still has records attached, so deleting them would change your ' +
          'savings history. Deactivate the member instead.',
        reason: 'has_history',
        constraint: m ? m[1] : null,
        can_deactivate: true
      });
    }
    console.error('Delete member failed:', error);
    res.status(500).json({ error: 'Failed to delete member.' });
  }
};

/**
 * Changes a member's account status: active, inactive or suspended.
 *
 * Separate from the general update endpoint because it is the alternative to
 * deleting somebody who has history, and it needs to refuse illegal transitions
 * rather than silently accept anything.
 */
const setMemberStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowed = ['active', 'inactive', 'suspended'];

    if (!allowed.includes(status)) {
      return res.status(400).json({
        error: `Status must be one of: ${allowed.join(', ')}.`
      });
    }

    const [member] = await pool.execute('SELECT id, full_name, status FROM members WHERE id = ?', [id]);
    if (member.length === 0) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    if (member[0].status === status) {
      return res.json({
        success: true,
        status,
        message: `${member[0].full_name} is already ${status}.`
      });
    }

    await pool.execute('UPDATE members SET status = ? WHERE id = ?', [status, id]);

    res.json({
      success: true,
      status,
      message:
        status === 'active'
          ? `${member[0].full_name} reactivated.`
          : `${member[0].full_name} is now ${status} and can no longer sign in. ` +
            'All their records are kept.'
    });
  } catch (error) {
    console.error('Set member status failed:', error);
    res.status(500).json({ error: 'Failed to update the member status.' });
  }
};

// Get member dashboard data
const getMemberDashboard = async (req, res) => {
  try {
    const memberId = req.user.id;

    const [member] = await pool.execute('SELECT * FROM members WHERE id = ?', [memberId]);

    const [contributions] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) as total FROM contributions WHERE member_id = ? AND status = 'confirmed'`,
      [memberId]
    );

    const [loanTotals] = await pool.execute(
      `SELECT COALESCE(SUM(balance), 0) as total_balance FROM loans WHERE member_id = ? AND status IN ('active', 'disbursed')`,
      [memberId]
    );

    // Full application history so the member can see what they applied for and
    // where it stands, not just a balance figure.
    const [applications] = await pool.execute(
      `SELECT id, principal_amount, interest_rate, interest_amount, total_repayable,
              amount_paid, balance, status, purpose, application_date, approval_date,
              disbursement_date, due_date
       FROM loans WHERE member_id = ?
       ORDER BY application_date DESC`,
      [memberId]
    );

    // Attach the interest/principal split so the member can see exactly what
    // they still owe and how much of it is interest.
    const loans = applications.map(decorateLoan);
    const loanSummary = summarise(loans);

    const [welfareRequests] = await pool.execute(
      `SELECT id, amount, reason, status, request_date, approval_date
       FROM welfare_requests WHERE member_id = ?
       ORDER BY request_date DESC LIMIT 5`,
      [memberId]
    );

    const [recentTransactions] = await pool.execute(
      `SELECT * FROM contributions WHERE member_id = ? ORDER BY created_at DESC LIMIT 5`,
      [memberId]
    );

    res.json({
      member: member[0],
      total_contributions: contributions[0].total,
      loan_balance: Number(loanTotals[0].total_balance),
      loans,
      loan_summary: loanSummary,
      welfare_requests: welfareRequests,
      recent_transactions: recentTransactions
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch dashboard data.' });
  }
};

/**
 * Pending self-registrations awaiting a decision.
 */
const getPendingMembers = async (req, res) => {
  try {
    const [pending] = await pool.execute(
      `SELECT id, full_name, email, phone, id_number, status, joined_date,
              emergency_contact_name, emergency_contact_phone, created_at
       FROM members
       WHERE status = 'pending'
       ORDER BY created_at ASC`
    );

    const [rejected] = await pool.execute(
      `SELECT id, full_name, phone, rejection_reason, approved_at AS reviewed_at
       FROM members
       WHERE status = 'rejected'
       ORDER BY approved_at DESC
       LIMIT 20`
    );

    const [counts] = await pool.execute(
      `SELECT
         SUM(CASE WHEN status = 'pending'  THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'active'   THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
       FROM members`
    );

    res.json({ pending, recently_rejected: rejected, counts: counts[0] });
  } catch (error) {
    console.error('Get pending members error:', error);
    res.status(500).json({ error: 'Failed to load registrations.' });
  }
};

/** Approve a pending registration. The member can log in immediately after. */
const approveMember = async (req, res) => {
  try {
    const { id } = req.params;

    const [rows] = await pool.execute(
      "SELECT id, full_name FROM members WHERE id = ? AND status = 'pending'",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No pending registration with that id.' });
    }

    await pool.execute(
      `UPDATE members
       SET status = 'active',
           approved_by = ?,
           approved_at = NOW(),
           reviewed_by = ?,
           rejection_reason = NULL
       WHERE id = ?`,
      [req.user.id, req.user.id, id]
    );

    res.json({
      success: true,
      message: `${rows[0].full_name} approved. They can now log in.`
    });
  } catch (error) {
    console.error('Approve member error:', error);
    res.status(500).json({ error: 'Failed to approve the registration.' });
  }
};

/** Reject a pending registration, with a reason the applicant can be told. */
const rejectMember = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Please give a reason for rejecting.' });
    }

    const [rows] = await pool.execute(
      "SELECT id, full_name FROM members WHERE id = ? AND status = 'pending'",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'No pending registration with that id.' });
    }

    await pool.execute(
      `UPDATE members
       SET status = 'rejected',
           rejection_reason = ?,
           reviewed_by = ?,
           approved_at = NOW()
       WHERE id = ?`,
      [String(reason).trim().slice(0, 255), req.user.id, id]
    );

    res.json({
      success: true,
      message: `${rows[0].full_name} was declined.`
    });
  } catch (error) {
    console.error('Reject member error:', error);
    res.status(500).json({ error: 'Failed to reject the registration.' });
  }
};

module.exports = {
  getAllMembers,
  getMember,
  createMember,
  updateMember,
  deleteMember,
  setMemberStatus,
  getMemberDashboard,
  getPendingMembers,
  approveMember,
  rejectMember
};
