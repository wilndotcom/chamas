const pool = require('../config/database');
const { dispatch } = require('../utils/notifier');

/** Reads one setting, falling back when the key is absent. */
const getSetting = async (key, fallback = null) => {
  const [rows] = await pool.execute(
    'SELECT setting_value FROM settings WHERE setting_key = ?',
    [key]
  );
  return rows.length ? rows[0].setting_value : fallback;
};

/** Reads a numeric setting. Garbage falls back rather than becoming NaN. */
const numberSetting = async (key, fallback) => {
  const raw = await getSetting(key, String(fallback));
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * What the welfare fund currently holds.
 *
 * Money in is confirmed contributions. Money out is disbursed requests, not
 * merely approved ones: approving a request is a decision, and treating it as
 * money paid out is how a fund appears to have handed over cash it still holds.
 */
const fundPosition = async () => {
  const [[inRow]] = await pool.execute(
    `SELECT COALESCE(SUM(amount), 0) AS total_in
       FROM welfare_contributions WHERE status = 'confirmed'`
  );
  const [[outRow]] = await pool.execute(
    `SELECT COALESCE(SUM(amount), 0) AS total_out
       FROM welfare_requests WHERE status = 'disbursed'`
  );
  const [[pendingRow]] = await pool.execute(
    `SELECT COALESCE(SUM(amount), 0) AS total_pending
       FROM welfare_requests WHERE status = 'pending'`
  );
  const [[membersRow]] = await pool.execute(
    `SELECT COUNT(DISTINCT member_id) AS contributors
       FROM welfare_contributions WHERE status = 'confirmed'`
  );

  const totalIn = Number(inRow.total_in);
  const totalOut = Number(outRow.total_out);
  return {
    total_in: totalIn,
    total_out: totalOut,
    available: Math.round((totalIn - totalOut) * 100) / 100,
    pending_requests: Number(pendingRow.total_pending),
    contributors: Number(membersRow.contributors)
  };
};

/**
 * Whether a member may request welfare right now, and why not if they may not.
 *
 * Returned as a reason rather than a boolean so the member portal can say what
 * is actually missing instead of showing a dead button.
 */
const eligibilityFor = async (memberId) => {
  if (await getSetting('welfare_enabled', '1') === '0') {
    return { allowed: false, reason: 'The welfare fund is switched off.' };
  }

  const cap = await numberSetting('welfare_max_request_amount', 0);
  const waiting = await numberSetting('welfare_min_months_contributed', 0);

  if (waiting > 0) {
    const [[row]] = await pool.execute(
      `SELECT COUNT(DISTINCT DATE_FORMAT(contribution_date, '%Y-%m')) AS months
         FROM welfare_contributions
        WHERE member_id = ? AND status = 'confirmed'`,
      [memberId]
    );
    if (Number(row.months) < waiting) {
      return {
        allowed: false,
        reason:
          `You have contributed for ${row.months} month(s). ` +
          `This group requires ${waiting} before a request can be made.`
      };
    }
  }

  /*
   * The cap is deliberately NOT checked here.
   *
   * It is the largest single request the group will pay, so it belongs in
   * submitWelfareRequest where the requested amount is known. Comparing it here
   * against the fund's balance refused every request whenever the balance fell
   * below the cap, so a fund holding 1,000 with a 5,000 cap told members they
   * could not ask for anything and the real reason - that they asked for too
   * much - never surfaced.
   */
  return { allowed: true, reason: null, cap, waiting };
};

// Get all welfare contributions
const getAllWelfareContributions = async (req, res) => {
  try {
    const [contributions] = await pool.execute(
      `SELECT w.*, m.full_name as member_name
       FROM welfare_contributions w
       JOIN members m ON w.member_id = m.id
       ORDER BY w.created_at DESC`
    );
    res.json({ contributions, fund: await fundPosition() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch welfare contributions.' });
  }
};

/**
 * Records a welfare contribution.
 *
 * Serves both callers. An admin names the member; a member contributes for
 * themselves and is not trusted to name anyone else. That difference is the
 * whole reason this used to be unreachable from the member portal.
 */
const recordWelfareContribution = async (req, res) => {
  try {
    // `authenticateEither` accepts both token kinds, so the role is read from the
    // token rather than from which middleware ran.
    const isMember = req.user.type === 'member';
    const { amount, payment_method, reference_number, remarks } = req.body;

    /*
     * Who the contribution is for.
     *
     * A member is always themselves. An admin may name any member, and if they
     * name nobody they are contributing for themselves - which is the whole point
     * of admins being members too, and what was impossible before they had a
     * member record.
     */
    let memberId;
    if (isMember) {
      memberId = req.user.id;
    } else if (req.body.member_id) {
      memberId = Number(req.body.member_id);
    } else {
      const [[own]] = await pool.execute(
        'SELECT member_id FROM admins WHERE id = ?',
        [req.user.id]
      );
      if (!own || !own.member_id) {
        return res.status(400).json({
          error: 'Choose which member this welfare contribution is for.'
        });
      }
      memberId = own.member_id;
    }

    // Validated as a positive number rather than merely truthy: the old check
    // accepted a string, and a negative amount would have drained the fund.
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: 'Enter an amount greater than zero.' });
    }

    if (await getSetting('welfare_enabled', '1') === '0') {
      return res.status(400).json({ error: 'The welfare fund is switched off.' });
    }

    /*
     * Permission, moved here from `authorize`.
     *
     * The route uses `authenticateEither` so members can reach it at all, and
     * `authorize` only understands admin tokens. So an admin's right to record
     * for other people is checked here, explicitly, rather than being implied by
     * having passed the middleware. Super admin bypasses, matching the rest of
     * the app.
     */
    if (!isMember) {
      const isSuper = req.user.role === 'super_admin';
      const allowed =
        isSuper ||
        (Array.isArray(req.user.permissions) && req.user.permissions.includes('record_contributions'));
      if (!allowed) {
        return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
      }
    }

    // A member may only self-contribute when the group allows it.
    if (isMember && await getSetting('welfare_allow_self_contribution', '1') === '0') {
      return res.status(403).json({
        error: 'Please ask an admin to record your welfare contribution.'
      });
    }

    const [[member]] = await pool.execute(
      'SELECT id, full_name, phone, email FROM members WHERE id = ?',
      [memberId]
    );
    if (!member) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    const [result] = await pool.execute(
      `INSERT INTO welfare_contributions
         (member_id, amount, contribution_date, payment_method, reference_number, status, remarks)
       VALUES (?, ?, CURDATE(), ?, ?, 'confirmed', ?)`,
      [memberId, value, payment_method || 'cash', reference_number || null, remarks || null]
    );

    // Tell the member their own contribution landed. A self-service payment that
    // produces no confirmation reads as money taken and not received.
    dispatch('sms', {
      to: member.phone,
      message:
        `Your welfare contribution has been received. ` +
        `Thank you for supporting the fund.`
    }).catch((e) => console.error('[welfare] notification failed:', e.message));

    res.status(201).json({
      success: true,
      contribution_id: result.insertId,
      fund: await fundPosition(),
      message: 'Welfare contribution recorded.'
    });
  } catch (error) {
    console.error('Record welfare contribution error:', error);
    res.status(500).json({ error: 'Failed to record welfare contribution.' });
  }
};

/**
 * Everything one member needs about the welfare fund.
 *
 * Scoped to their own rows. Before this existed a member could submit a request
 * and then had no way to see its outcome, which is the single most likely reason
 * for a fund to lose trust.
 */
const getMyWelfare = async (req, res) => {
  try {
    const memberId = req.user.id;

    const [contributions] = await pool.execute(
      `SELECT id, amount, contribution_date, payment_method, reference_number, status, remarks
         FROM welfare_contributions
        WHERE member_id = ?
        ORDER BY contribution_date DESC, id DESC`,
      [memberId]
    );

    const [requests] = await pool.execute(
      `SELECT w.id, w.amount, w.reason, w.status, w.request_date, w.approval_date,
              a.full_name AS decided_by
         FROM welfare_requests w
         LEFT JOIN admins a ON w.approved_by = a.id
        WHERE w.member_id = ?
        ORDER BY w.request_date DESC, w.id DESC`,
      [memberId]
    );

    const [[totals]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS contributed
         FROM welfare_contributions
        WHERE member_id = ? AND status = 'confirmed'`,
      [memberId]
    );

    const [[received]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS received
         FROM welfare_requests
        WHERE member_id = ? AND status = 'disbursed'`,
      [memberId]
    );

    const [[thisMonth]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS amount
         FROM welfare_contributions
        WHERE member_id = ? AND status = 'confirmed'
          AND contribution_date = CURDATE() - INTERVAL (DAYOFMONTH(CURDATE()) - 1) DAY`,
      [memberId]
    );

    res.json({
      contributions,
      requests,
      totals: {
        contributed_all_time: Number(totals.contributed),
        received_all_time: Number(received.received),
        contributed_this_month: Number(thisMonth.amount),
        usual_amount: await numberSetting('welfare_contribution', 0)
      },
      fund: await fundPosition(),
      eligibility: await eligibilityFor(memberId),
      can_contribute:
        (await getSetting('welfare_allow_self_contribution', '1')) === '1' &&
        (await getSetting('welfare_enabled', '1')) === '1',
      needs_approval: (await getSetting('welfare_request_needs_approval', '1')) === '1'
    });
  } catch (error) {
    console.error('Get my welfare error:', error);
    res.status(500).json({ error: 'Failed to fetch your welfare details.' });
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
    res.json({ requests, fund: await fundPosition() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch welfare requests.' });
  }
};

// Submit welfare request
const submitWelfareRequest = async (req, res) => {
  try {
    const { amount, reason } = req.body;
    const memberId = req.user.id;

    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      return res.status(400).json({ error: 'Enter an amount greater than zero.' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'Please give a reason for the request.' });
    }

    const eligibility = await eligibilityFor(memberId);
    if (!eligibility.allowed) {
      return res.status(403).json({ error: eligibility.reason });
    }

    // The cap is checked against the fund's actual balance, so two requests
    // approved in the same sitting cannot together promise money the fund
    // does not hold.
    if (eligibility.cap > 0 && value > eligibility.cap) {
      return res.status(400).json({
        error: `This group limits welfare requests to ${eligibility.cap}.`
      });
    }

    const needsApproval = (await getSetting('welfare_request_needs_approval', '1')) === '1';

    // When the group does not require approval, a valid request is settled on
    // submission rather than sitting in a queue nobody will ever clear.
    const status = needsApproval ? 'pending' : 'disbursed';

    /*
     * Who decided, when no committee was involved.
     *
     * approved_by is a foreign key to admins(id), so a member's own id cannot go
     * there: when the group runs welfare without approval, the deciding member
     * submitted it themselves and there is no admin to name. NULL is the honest
     * value - the request was self-submitted, and recording a member id in an
     * admin column made the whole insert fail.
     */
    const deciderId = needsApproval || req.user.type === 'member' ? null : req.user.id;

    const [result] = await pool.execute(
      `INSERT INTO welfare_requests
         (member_id, amount, reason, status, request_date, approved_by, approval_date)
       VALUES (?, ?, ?, ?, CURDATE(), ?, CURDATE())`,
      [memberId, value, String(reason).trim(), status, deciderId]
    );

    let ledgerId = null;
    if (!needsApproval) {
      // Money actually left the fund, so the cash book has to show it.
      const [[member]] = await pool.execute(
        'SELECT id, full_name FROM members WHERE id = ?',
        [memberId]
      );
      const [entry] = await pool.execute(
        `INSERT INTO ledger_entries
           (direction, category, description, amount, entry_date, payment_method, member_id, recorded_by)
         VALUES ('out', 'Welfare disbursement', ?, ?, CURDATE(), 'cash', ?, ?)`,
        [`Welfare to ${member.full_name}: ${String(reason).trim()}`, value, memberId, deciderId]
      );
      ledgerId = entry.insertId;
    }

    const [[member]] = await pool.execute(
      'SELECT id, full_name, phone FROM members WHERE id = ?',
      [memberId]
    );

    dispatch('sms', {
      to: member.phone,
      message: needsApproval
        ? `Your welfare request has been received and is waiting for approval.`
        : `Your welfare request has been paid.`
    }).catch((e) => console.error('[welfare] notification failed:', e.message));

    res.status(201).json({
      success: true,
      request_id: result.insertId,
      status,
      needs_approval: needsApproval,
      ledger_id: ledgerId,
      fund: await fundPosition(),
      message: needsApproval
        ? 'Welfare request submitted and waiting for approval.'
        : 'Welfare request submitted and paid.'
    });
  } catch (error) {
    console.error('Submit welfare request error:', error);
    res.status(500).json({ error: 'Failed to submit welfare request.' });
  }
};

// Approve welfare request
const approveWelfareRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const [[request]] = await pool.execute(
      `SELECT w.id, w.member_id, w.amount, w.reason, w.status, m.full_name, m.phone
         FROM welfare_requests w
         JOIN members m ON w.member_id = m.id
        WHERE w.id = ?`,
      [id]
    );
    if (!request) {
      return res.status(404).json({ error: 'Welfare request not found.' });
    }

    // Approving an already-decided request would let a second click overwrite the
    // first decision and pay the member twice.
    if (request.status !== 'pending') {
      return res.status(409).json({
        error: `This request was already ${request.status}.`
      });
    }

    const position = await fundPosition();
    if (Number(request.amount) > position.available) {
      return res.status(400).json({
        error:
          `The fund holds ${position.available} but this request is for ` +
          `${request.amount}. Approving it would promise money the fund does not have.`
      });
    }

    await pool.execute(
      `UPDATE welfare_requests
          SET status = 'approved', approved_by = ?, approval_date = CURDATE()
        WHERE id = ?`,
      [req.user.id, id]
    );

    dispatch('sms', {
      to: request.phone,
      message: `Your welfare request has been approved. It will be paid out shortly.`
    }).catch((e) => console.error('[welfare] notification failed:', e.message));

    res.json({ success: true, message: 'Welfare request approved.', fund: await fundPosition() });
  } catch (error) {
    console.error('Approve welfare request error:', error);
    res.status(500).json({ error: 'Failed to approve welfare request.' });
  }
};

/**
 * Pays an approved request out.
 *
 * Separate from approval on purpose. Approving says the committee agreed;
 * disbursing says the money moved. Collapsing them meant an approved request
 * looked paid in the balance while the cash was still sitting in the fund.
 */
const disburseWelfareRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const [[request]] = await pool.execute(
      `SELECT w.id, w.member_id, w.amount, w.reason, w.status, m.full_name, m.phone
         FROM welfare_requests w
         JOIN members m ON w.member_id = m.id
        WHERE w.id = ?`,
      [id]
    );
    if (!request) {
      return res.status(404).json({ error: 'Welfare request not found.' });
    }
    if (request.status !== 'approved') {
      return res.status(409).json({
        error: `Only an approved request can be paid out. This one is ${request.status}.`
      });
    }

    const position = await fundPosition();
    if (Number(request.amount) > position.available) {
      return res.status(400).json({
        error:
          `The fund holds ${position.available} but this request is for ` +
          `${request.amount}.`
      });
    }

    await pool.execute(
      `UPDATE welfare_requests SET status = 'disbursed' WHERE id = ?`,
      [id]
    );

    const [entry] = await pool.execute(
      `INSERT INTO ledger_entries
         (direction, category, description, amount, entry_date, payment_method, member_id, recorded_by)
       VALUES ('out', 'Welfare disbursement', ?, ?, CURDATE(), 'cash', ?, ?)`,
      [
        `Welfare to ${request.full_name}: ${request.reason}`,
        request.amount,
        request.member_id,
        req.user.id
      ]
    );

    dispatch('sms', {
      to: request.phone,
      message: `Your welfare payment has been sent. Thank you.`
    }).catch((e) => console.error('[welfare] notification failed:', e.message));

    res.json({
      success: true,
      ledger_id: entry.insertId,
      fund: await fundPosition(),
      message: 'Welfare request paid out.'
    });
  } catch (error) {
    console.error('Disburse welfare request error:', error);
    res.status(500).json({ error: 'Failed to pay out welfare request.' });
  }
};

// Reject welfare request
const rejectWelfareRequest = async (req, res) => {
  try {
    const { id } = req.params;

    const [[request]] = await pool.execute(
      `SELECT w.id, w.status, m.phone FROM welfare_requests w
        JOIN members m ON w.member_id = m.id
       WHERE w.id = ?`,
      [id]
    );
    if (!request) {
      return res.status(404).json({ error: 'Welfare request not found.' });
    }
    if (request.status !== 'pending') {
      return res.status(409).json({
        error: `This request was already ${request.status}.`
      });
    }

    await pool.execute(
      `UPDATE welfare_requests SET status = 'rejected', approved_by = ?, approval_date = CURDATE() WHERE id = ?`,
      [req.user.id, id]
    );

    dispatch('sms', {
      to: request.phone,
      message: `Your welfare request was not approved. Please speak to the committee.`
    }).catch((e) => console.error('[welfare] notification failed:', e.message));

    res.json({ success: true, message: 'Welfare request rejected.', fund: await fundPosition() });
  } catch (error) {
    console.error('Reject welfare request error:', error);
    res.status(500).json({ error: 'Failed to reject welfare request.' });
  }
};

/** The fund's position and rules, for the admin panel and the settings card. */
const getWelfareFund = async (req, res) => {
  try {
    res.json({
      fund: await fundPosition(),
      rules: {
        enabled: (await getSetting('welfare_enabled', '1')) === '1',
        usual_amount: await numberSetting('welfare_contribution', 0),
        allow_self_contribution:
          (await getSetting('welfare_allow_self_contribution', '1')) === '1',
        needs_approval: (await getSetting('welfare_request_needs_approval', '1')) === '1',
        max_request_amount: await numberSetting('welfare_max_request_amount', 0),
        min_months_contributed: await numberSetting('welfare_min_months_contributed', 0)
      }
    });
  } catch (error) {
    console.error('Get welfare fund error:', error);
    res.status(500).json({ error: 'Failed to fetch the welfare fund position.' });
  }
};

module.exports = {
  getAllWelfareContributions,
  recordWelfareContribution,
  getMyWelfare,
  getWelfareRequests,
  submitWelfareRequest,
  approveWelfareRequest,
  disburseWelfareRequest,
  rejectWelfareRequest,
  getWelfareFund,
  getSetting,
  fundPosition,
  eligibilityFor
};
