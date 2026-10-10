const pool = require('../config/database');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Cash book.
 *
 * Merges every source of cash into one ledger so the balance is explainable:
 *
 *   MONEY IN   member savings, loan repayments, welfare contributions, other income
 *   MONEY OUT  operating expenses, loans disbursed, welfare paid out, other spending
 *
 * Two distinctions matter and are reported separately, because collapsing them
 * makes the books wrong:
 *
 *   1. Loans disbursed leave the bank but are not spending. They become a
 *      receivable, so they sit in "money out" for the cash book but must be
 *      added back when working out what the chama actually owns.
 *   2. Member savings and welfare funds are member money held on trust. They are
 *      a liability, never profit.
 *
 * Profit here is therefore cash-basis and is expected to differ from the
 * accrual figures in /api/reports/growth (interest charged vs interest collected).
 */

const DATE_FROM = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 11);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
};

const getCashBook = async (req, res) => {
  try {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '')
      ? req.query.from
      : DATE_FROM();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '')
      ? req.query.to
      : new Date().toISOString().slice(0, 10);

    /* --------------------------------------------------------- money in --- */

    const [savingsIn] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM contributions
       WHERE status = 'confirmed' AND contribution_date BETWEEN ? AND ?`,
      [from, to]
    );

    const [repaymentsIn] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM loan_repayments WHERE payment_date BETWEEN ? AND ?`,
      [from, to]
    );

    const [welfareIn] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM welfare_contributions
       WHERE status = 'confirmed' AND contribution_date BETWEEN ? AND ?`,
      [from, to]
    );

    const [otherIn] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM ledger_entries
       WHERE direction = 'in' AND entry_date BETWEEN ? AND ?`,
      [from, to]
    );

    /* -------------------------------------------------------- money out --- */

    const [expensesOut] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM expenses WHERE expense_date BETWEEN ? AND ?`,
      [from, to]
    );

    const [loansOut] = await pool.execute(
      `SELECT COALESCE(SUM(principal_amount), 0) AS total, COUNT(*) AS count
       FROM loans
       WHERE disbursement_date IS NOT NULL
         AND status IN ('active', 'disbursed', 'completed')
         AND disbursement_date BETWEEN ? AND ?`,
      [from, to]
    );

    const [welfareOut] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM welfare_requests
       WHERE status IN ('approved', 'disbursed') AND request_date BETWEEN ? AND ?`,
      [from, to]
    );

    const [otherOut] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM ledger_entries
       WHERE direction = 'out' AND entry_date BETWEEN ? AND ?`,
      [from, to]
    );

    const totalIn =
      Number(savingsIn[0].total) +
      Number(repaymentsIn[0].total) +
      Number(welfareIn[0].total) +
      Number(otherIn[0].total);

    const totalOut =
      Number(expensesOut[0].total) +
      Number(loansOut[0].total) +
      Number(welfareOut[0].total) +
      Number(otherOut[0].total);

    /* --------------------------------------------- opening balance (all time) --- */

    const [priorIn] = await pool.execute(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0) FROM contributions
            WHERE status = 'confirmed' AND contribution_date < ?) +
         (SELECT COALESCE(SUM(amount), 0) FROM loan_repayments WHERE payment_date < ?) +
         (SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions
            WHERE status = 'confirmed' AND contribution_date < ?) +
         (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
            WHERE direction = 'in' AND entry_date < ?) AS total`,
      [from, from, from, from]
    );

    const [priorOut] = await pool.execute(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE expense_date < ?) +
         (SELECT COALESCE(SUM(principal_amount), 0) FROM loans
            WHERE disbursement_date IS NOT NULL
              AND status IN ('active','disbursed','completed') AND disbursement_date < ?) +
         (SELECT COALESCE(SUM(amount), 0) FROM welfare_requests
            WHERE status IN ('approved','disbursed') AND request_date < ?) +
         (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries
            WHERE direction = 'out' AND entry_date < ?) AS total`,
      [from, from, from, from]
    );

    const openingBalance = Number(priorIn[0].total) - Number(priorOut[0].total);
    const closingBalance = openingBalance + totalIn - totalOut;

    /* -------------------------------------- trust money and receivables (all time) --- */

    const [position] = await pool.execute(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0) FROM contributions WHERE status = 'confirmed')       AS savings_held,
         (SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions WHERE status = 'confirmed') AS welfare_held,
         (SELECT COALESCE(SUM(amount), 0) FROM welfare_requests
            WHERE status IN ('approved','disbursed'))                                           AS welfare_paid,
         (SELECT COALESCE(SUM(balance), 0) FROM loans WHERE status IN ('active','disbursed'))   AS receivable,
         (SELECT COALESCE(SUM(amount), 0) FROM expenses)                                        AS expenses_all,
         (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries WHERE direction = 'in')           AS other_in_all`
    );

    const p = position[0];
    const savingsHeld = Number(p.savings_held);
    const welfareHeld = Number(p.welfare_held);
    const welfarePaid = Number(p.welfare_paid);
    const receivable = Number(p.receivable);
    const trustLiability = savingsHeld + (welfareHeld - welfarePaid);

    // What the chama genuinely owns: cash plus what members owe it.
    const netWorth = closingBalance + receivable;

    /* ------------------------------------------------------ itemised ledger --- */

    const [entries] = await pool.execute(
      `SELECT 'savings' AS source, c.id, c.contribution_date AS entry_date, c.amount,
              CONCAT('Monthly savings from ', m.full_name) AS description,
              c.payment_method, c.reference_number, m.full_name AS member_name
       FROM contributions c JOIN members m ON c.member_id = m.id
       WHERE c.status = 'confirmed' AND c.contribution_date BETWEEN ? AND ?

       UNION ALL
       SELECT 'repayment', r.id, r.payment_date, r.amount,
              CONCAT('Loan repayment from ', m.full_name), r.payment_method,
              r.reference_number, m.full_name
       FROM loan_repayments r JOIN members m ON r.member_id = m.id
       WHERE r.payment_date BETWEEN ? AND ?

       UNION ALL
       SELECT 'welfare_in', w.id, w.contribution_date, w.amount,
              CONCAT('Welfare contribution from ', m.full_name), w.payment_method,
              w.reference_number, m.full_name
       FROM welfare_contributions w JOIN members m ON w.member_id = m.id
       WHERE w.status = 'confirmed' AND w.contribution_date BETWEEN ? AND ?

       UNION ALL
       SELECT 'expense', e.id, e.expense_date, e.amount,
              COALESCE(NULLIF(e.description, ''), e.category), e.payment_method,
              e.reference_number, NULL
       FROM expenses e WHERE e.expense_date BETWEEN ? AND ?

       UNION ALL
       SELECT 'loan_disbursed', l.id, l.disbursement_date, l.principal_amount,
              CONCAT('Loan disbursed to ', m.full_name, COALESCE(CONCAT(' for ', l.purpose), '')),
              'mpesa_stk', NULL, m.full_name
       FROM loans l JOIN members m ON l.member_id = m.id
       WHERE l.disbursement_date IS NOT NULL
         AND l.status IN ('active','disbursed','completed')
         AND l.disbursement_date BETWEEN ? AND ?

       UNION ALL
       SELECT 'welfare_out', wr.id, wr.request_date, wr.amount,
              CONCAT('Welfare paid to ', m.full_name, ': ', LEFT(COALESCE(wr.reason,''), 60)),
              'mpesa_stk', NULL, m.full_name
       FROM welfare_requests wr JOIN members m ON wr.member_id = m.id
       WHERE wr.status IN ('approved','disbursed') AND wr.request_date BETWEEN ? AND ?

       UNION ALL
       SELECT 'other_in', le.id, le.entry_date, le.amount,
              CONCAT('[', le.category, '] ', COALESCE(le.description, 'Other income')),
              le.payment_method, le.reference_number, m.full_name
       FROM ledger_entries le LEFT JOIN members m ON le.member_id = m.id
       WHERE le.direction = 'in' AND le.entry_date BETWEEN ? AND ?

       UNION ALL
       SELECT 'other_out', le.id, le.entry_date, le.amount,
              CONCAT('[', le.category, '] ', COALESCE(le.description, 'Other spending')),
              le.payment_method, le.reference_number, m.full_name
       FROM ledger_entries le LEFT JOIN members m ON le.member_id = m.id
       WHERE le.direction = 'out' AND le.entry_date BETWEEN ? AND ?

       ORDER BY entry_date DESC, source`,
      [from, to, from, to, from, to, from, to, from, to, from, to, from, to, from, to]
    );

    const decorated = entries.map((e) => ({
      ...e,
      amount: round2(e.amount),
      direction: ['savings', 'repayment', 'welfare_in', 'other_in'].includes(e.source)
        ? 'in'
        : 'out'
    }));

    /* ---------------------------------------------------- category breakdown --- */

    const outByCategory = [
      { category: 'Loans disbursed (receivable)', total: Number(loansOut[0].total), count: Number(loansOut[0].count) },
      { category: 'Operating expenses', total: Number(expensesOut[0].total), count: Number(expensesOut[0].count) },
      { category: 'Welfare paid out', total: Number(welfareOut[0].total), count: Number(welfareOut[0].count) },
      { category: 'Other spending', total: Number(otherOut[0].total), count: Number(otherOut[0].count) }
    ].filter((r) => r.total > 0);

    const inByCategory = [
      { category: 'Member savings', total: Number(savingsIn[0].total), count: Number(savingsIn[0].count) },
      { category: 'Loan repayments', total: Number(repaymentsIn[0].total), count: Number(repaymentsIn[0].count) },
      { category: 'Welfare contributions', total: Number(welfareIn[0].total), count: Number(welfareIn[0].count) },
      { category: 'Other income', total: Number(otherIn[0].total), count: Number(otherIn[0].count) }
    ].filter((r) => r.total > 0);

    res.json({
      period: { from, to },
      balance: {
        opening: round2(openingBalance),
        total_in: round2(totalIn),
        total_out: round2(totalOut),
        closing: round2(closingBalance)
      },
      position: {
        cash: round2(closingBalance),
        receivable_from_members: round2(receivable),
        net_worth: round2(netWorth),
        held_for_members: round2(trustLiability),
        savings_held: round2(savingsHeld),
        welfare_held: round2(welfareHeld - welfarePaid),
        note:
          'Member savings and welfare funds are member money held on trust. They are a liability, not profit.'
      },
      money_in: inByCategory,
      money_out: outByCategory.map((r) => ({
        ...r,
        total: round2(r.total)
      })),
      entries: decorated,
      totals: {
        entry_count: decorated.length,
        operating_spend_only: round2(
          Number(expensesOut[0].total) + Number(otherOut[0].total)
        )
      }
    });
  } catch (error) {
    console.error('Cash book error:', error);
    res.status(500).json({ error: 'Failed to build the cash book.' });
  }
};

/** Record a manual money-in or money-out entry. */
const recordLedgerEntry = async (req, res) => {
  try {
    const {
      direction,
      category,
      description,
      amount,
      entry_date,
      payment_method,
      reference_number,
      member_id
    } = req.body;

    if (!direction || !['in', 'out'].includes(direction)) {
      return res.status(400).json({ error: "Direction must be 'in' or 'out'." });
    }
    if (!category) {
      return res.status(400).json({ error: 'Category is required.' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than zero.' });
    }
    if (!entry_date) {
      return res.status(400).json({ error: 'Date is required.' });
    }

    const [result] = await pool.execute(
      `INSERT INTO ledger_entries
         (direction, category, description, amount, entry_date, payment_method, reference_number, member_id, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        direction,
        category,
        description || null,
        amount,
        entry_date,
        payment_method || 'cash',
        reference_number || null,
        member_id || null,
        req.user.id
      ]
    );

    res.status(201).json({
      success: true,
      entry_id: result.insertId,
      message: `Money ${direction === 'in' ? 'received' : 'paid out'} recorded.`
    });
  } catch (error) {
    console.error('Record ledger entry error:', error);
    res.status(500).json({ error: 'Failed to record the entry.' });
  }
};

const deleteLedgerEntry = async (req, res) => {
  try {
    const { id } = req.params;
    const [result] = await pool.execute('DELETE FROM ledger_entries WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Entry not found.' });
    }
    res.json({ success: true, message: 'Entry deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete the entry.' });
  }
};

module.exports = { getCashBook, recordLedgerEntry, deleteLedgerEntry };