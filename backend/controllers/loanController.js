const pool = require('../config/database');
const { decorateLoan, summarise, round2, dateOnly } = require('../utils/loanMath');
const { getSetting } = require('../utils/riskMembers');

/**
 * Loan interest rule
 * ------------------
 * Chama interest is FLAT and charged once on the principal for the whole term.
 * It is not a reducing balance, and it is not compounded on what is still owed:
 *
 *     interest  = principal * rate / 100
 *     repayable = principal + interest      <- the member repays this in full
 *
 * A 1,000 loan at 10% is repayable at 1,100, never 1,105, 1,110.50 and so on.
 * The rate is copied onto the loan row when the member applies, so raising the
 * default later never changes the price of a loan already taken.
 */
const MAX_RATE = 100;
const MAX_DURATION_MONTHS = 60;

/** Validates a rate as a percentage. Returns null when it is not usable. */
const parseRate = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > MAX_RATE) return null;
  return round2(rate);
};

/** Validates a term in whole months. Returns null when it is not usable. */
const parseDuration = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const months = Number(value);
  if (!Number.isFinite(months) || months < 1 || months > MAX_DURATION_MONTHS) return null;
  return Math.round(months);
};

// Get all loans
const getAllLoans = async (req, res) => {
  try {
    const [loans] = await pool.execute(
      `SELECT l.*, m.full_name as member_name, a.full_name as approved_by_name
       FROM loans l
       JOIN members m ON l.member_id = m.id
       LEFT JOIN admins a ON l.approved_by = a.id
       ORDER BY l.created_at DESC`
    );
    res.json({ loans });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch loans.' });
  }
};

// Apply for loan
const applyForLoan = async (req, res) => {
  try {
    const { principal_amount, purpose } = req.body;
    const memberId = req.user.id;

    const principal = round2(principal_amount);
    if (!Number.isFinite(principal) || principal <= 0) {
      return res.status(400).json({ error: 'Enter a loan amount greater than zero.' });
    }

    // The rate is snapshotted onto the loan now. Changing the default in
    // settings afterwards must not reprice a loan the member already applied for.
    const rate = parseRate(await getSetting('loan_interest_rate', '10')) ?? 10;
    const interestAmount = round2((principal * rate) / 100);
    const totalRepayable = round2(principal + interestAmount);

    const [result] = await pool.execute(
      `INSERT INTO loans (member_id, principal_amount, interest_rate, interest_amount, total_repayable, balance, purpose, application_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE())`,
      [memberId, principal, rate, interestAmount, totalRepayable, totalRepayable, purpose]
    );

    res.status(201).json({
      success: true,
      loan_id: result.insertId,
      interest_rate: rate,
      interest_amount: interestAmount,
      total_repayable: totalRepayable,
      message: 'Loan application submitted.'
    });
  } catch (error) {
    // Logged so a 500 is diagnosable instead of a silent shrug.
    console.error('[loans] apply failed:', error);
    res.status(500).json({ error: 'Failed to apply for loan.' });
  }
};

// Approve loan
const approveLoan = async (req, res) => {
  try {
    const { id } = req.params;

    const [loans] = await pool.execute(
      'SELECT l.*, m.full_name AS member_name FROM loans l JOIN members m ON m.id = l.member_id WHERE l.id = ?',
      [id]
    );
    if (loans.length === 0) {
      return res.status(404).json({ error: 'Loan not found.' });
    }

    const loan = loans[0];

    if (loan.status !== 'pending') {
      return res.status(400).json({ error: `This loan was already ${loan.status}.` });
    }

    // An explicit rate overrides the snapshot; otherwise the member keeps the
    // price they applied at.
    const requestedRate = parseRate(req.body.interest_rate);
    if (req.body.interest_rate !== undefined && requestedRate === null) {
      return res.status(400).json({ error: `Interest rate must be between 0 and ${MAX_RATE}%.` });
    }
    const rate = requestedRate ?? parseRate(loan.interest_rate) ?? 10;

    const requestedMonths = parseDuration(req.body.duration_months);
    if (req.body.duration_months !== undefined && requestedMonths === null) {
      return res.status(400).json({
        error: `Loan duration must be between 1 and ${MAX_DURATION_MONTHS} months.`
      });
    }
    // Fall back to the configured default term, not a hardcoded 3 months.
    const durationMonths =
      requestedMonths ?? parseDuration(await getSetting('loan_duration_months', '3')) ?? 3;

    const interestAmount = round2((Number(loan.principal_amount) * rate) / 100);
    const totalRepayable = round2(Number(loan.principal_amount) + interestAmount);

    const dueDate = new Date();
    dueDate.setMonth(dueDate.getMonth() + durationMonths);

    await pool.execute(
      `UPDATE loans SET status = 'approved', interest_rate = ?, interest_amount = ?, total_repayable = ?, balance = ?, approval_date = CURDATE(), due_date = ?, approved_by = ? WHERE id = ?`,
      [rate, interestAmount, totalRepayable, totalRepayable, dueDate, req.user.id, id]
    );

    res.json({
      success: true,
      interest_rate: rate,
      interest_amount: interestAmount,
      total_repayable: totalRepayable,
      duration_months: durationMonths,
      due_date: dateOnly(dueDate),
      message: 'Loan approved successfully.'
    });
  } catch (error) {
    console.error('[loans] approve failed:', error);
    res.status(500).json({ error: 'Failed to approve loan.' });
  }
};

// Disburse loan
const disburseLoan = async (req, res) => {
  try {
    const { id } = req.params;

    await pool.execute(
      `UPDATE loans SET status = 'active', disbursement_date = CURDATE() WHERE id = ?`,
      [id]
    );

    res.json({ success: true, message: 'Loan disbursed successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to disburse loan.' });
  }
};

// Record loan repayment
/**
 * Applies one repayment to a loan.
 *
 * Shared by the admin route and the member self-service route so both enforce
 * exactly the same rules.
 *
 * Returns { ok: true, ... } or { ok: false, status, error }.
 *
 *   ok = false  -> nothing was written
 *   ok = true   -> the loan and the repayment row were written together
 *
 * The guards matter more than they look. This function previously accepted a
 * negative amount, which *increased* the balance, and accepted any amount,
 * which could push amount_paid far beyond total_repayable and corrupt the
 * profit figures that sum loan totals.
 */
const applyRepayment = async (conn, { loan, amount, paymentMethod, reference, remarks, recordedBy }) => {
  const balance = round2(loan.balance);
  const total = round2(loan.total_repayable);

  const value = round2(amount);

  if (!Number.isFinite(value)) {
    return { ok: false, status: 400, error: 'Enter a repayment amount.' };
  }
  if (value <= 0) {
    return { ok: false, status: 400, error: 'Repayment must be greater than zero.' };
  }
  if (balance <= 0) {
    return { ok: false, status: 400, error: 'This loan is already fully repaid.' };
  }
  if (!['approved', 'active', 'disbursed'].includes(loan.status)) {
    return {
      ok: false,
      status: 400,
      error: `A loan that is ${loan.status} cannot take a repayment.`
    };
  }
  if (value > balance) {
    return {
      ok: false,
      status: 400,
      error: `That is more than the balance. The most you can pay now is ${balance.toFixed(2)}.`
    };
  }

  const newBalance = round2(balance - value);
  const clears = newBalance <= 0;

  // amount_paid is derived, never incremented blindly, so it can never drift
  // past total_repayable.
  const newPaid = round2(Math.min(total, round2(loan.amount_paid) + value));

  await conn.execute(
    `UPDATE loans SET balance = ?, amount_paid = ?, status = ? WHERE id = ?`,
    [newBalance, newPaid, clears ? 'completed' : loan.status, loan.id]
  );

  await conn.execute(
    `INSERT INTO loan_repayments
       (loan_id, member_id, amount, payment_date, payment_method, reference_number, remarks, recorded_by)
     VALUES (?, ?, ?, CURDATE(), ?, ?, ?, ?)`,
    [
      loan.id,
      loan.member_id,
      value,
      paymentMethod || 'cash',
      reference || null,
      remarks || null,
      recordedBy === undefined ? null : recordedBy
    ]
  );

  return {
    ok: true,
    loan_id: loan.id,
    amount: value,
    balance_before: balance,
    balance_after: newBalance,
    amount_paid: newPaid,
    total_repayable: total,
    cleared: clears,
    interest_outstanding: round2(newBalance > 0 && total > 0 ? (newBalance / total) * Number(loan.interest_amount) : 0)
  };
};

// Record a repayment on behalf of a member (admin action)
const recordRepayment = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { loan_id, amount, payment_method, reference_number, remarks } = req.body;

    const [loans] = await pool.execute('SELECT * FROM loans WHERE id = ?', [loan_id]);
    if (loans.length === 0) {
      return res.status(404).json({ error: 'Loan not found.' });
    }

    await conn.beginTransaction();
    const result = await applyRepayment(conn, {
      loan: loans[0],
      amount,
      paymentMethod: payment_method,
      reference: reference_number,
      remarks,
      recordedBy: req.user.id
    });
    await conn.commit();

    if (!result.ok) return res.status(result.status).json({ error: result.error });

    res.json({
      success: true,
      message: result.cleared
        ? 'Repayment recorded. This loan is now fully repaid.'
        : 'Repayment recorded successfully.',
      new_balance: result.balance_after,
      amount_paid: result.amount_paid,
      cleared: result.cleared,
      interest_outstanding: result.interest_outstanding
    });
  } catch (error) {
    await conn.rollback();
    console.error('[loans] repayment failed:', error);
    res.status(500).json({ error: 'Failed to record repayment. Nothing was changed.' });
  } finally {
    conn.release();
  }
};

/**
 * A member repaying their own loan, in full or in part.
 *
 * Member-scoped: the loan id comes from the path, not the body, so there is
 * nothing for a member to tamper with. Ownership is re-checked here rather than
 * trusted from the row, because an admin token and a member token must not be
 * interchangeable on this route.
 */
const repayMyLoan = async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { id } = req.params;
    const { amount, payment_method, reference_number, remarks } = req.body;

    const [loans] = await pool.execute(
      'SELECT * FROM loans WHERE id = ? AND member_id = ?',
      [id, req.user.id]
    );
    if (loans.length === 0) {
      // Same response as a genuinely missing loan, so the endpoint cannot be
      // used to discover whether someone else's loan id exists.
      return res.status(404).json({ error: 'Loan not found.' });
    }

    await conn.beginTransaction();
    const result = await applyRepayment(conn, {
      loan: loans[0],
      amount,
      paymentMethod: payment_method,
      reference: reference_number,
      remarks,
      // recorded_by stays NULL: nobody on the admin side entered this.
      recordedBy: null
    });
    await conn.commit();

    if (!result.ok) return res.status(result.status).json({ error: result.error });

    res.json({
      success: true,
      message: result.cleared
        ? 'Payment received in full. This loan is now closed.'
        : 'Payment received. Thank you.',
      balance_before: result.balance_before,
      balance_after: result.balance_after,
      amount_paid: result.amount_paid,
      total_repayable: result.total_repayable,
      cleared: result.cleared,
      interest_outstanding: result.interest_outstanding
    });
  } catch (error) {
    await conn.rollback();
    console.error('[loans] member repayment failed:', error);
    res.status(500).json({ error: 'Could not record your payment. Nothing was changed.' });
  } finally {
    conn.release();
  }
};

// Get pending loans
const getPendingLoans = async (req, res) => {
  try {
    const [loans] = await pool.execute(
      `SELECT l.*, m.full_name as member_name, m.phone as member_phone
       FROM loans l JOIN members m ON l.member_id = m.id
       WHERE l.status = 'pending' ORDER BY l.application_date ASC`
    );
    res.json({ loans });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch pending loans.' });
  }
};

/** A member's own loan applications. Members cannot list other members' loans. */
const getMyLoans = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, principal_amount, interest_rate, interest_amount, total_repayable,
              amount_paid, balance, status, purpose, application_date, approval_date,
              disbursement_date, due_date
       FROM loans WHERE member_id = ?
       ORDER BY application_date DESC`,
      [req.user.id]
    );

    const [repayments] = await pool.execute(
      `SELECT id, loan_id, amount, payment_date, payment_method
       FROM loan_repayments WHERE member_id = ?
       ORDER BY payment_date DESC LIMIT 50`,
      [req.user.id]
    );

    // Include the interest/principal breakdown so members see what they owe.
    const loans = rows.map(decorateLoan);

    res.json({ loans, repayments, summary: summarise(loans) });
  } catch (error) {
    console.error('Get my loans error:', error);
    res.status(500).json({ error: 'Failed to load your loans.' });
  }
};

module.exports = {
  getAllLoans,
  getMyLoans,
  applyForLoan,
  approveLoan,
  disburseLoan,
  recordRepayment,
  repayMyLoan,
  getPendingLoans
};
