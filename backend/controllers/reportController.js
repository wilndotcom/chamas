const pool = require('../config/database');
const { findRiskMembers, getSetting } = require('../utils/riskMembers');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Chama growth, interest and profit.
 *
 * Income for a chama is interest charged on loans. Savings contributions are
 * member money held on trust, not income, so they are reported separately from
 * profit. Interest payable to members on exit is treated as a liability.
 */
const getGrowthMetrics = async (req, res) => {
  try {
    const loanRate = Number(await getSetting('loan_interest_rate', '10'));
    const savingsRate = Number(await getSetting('savings_interest_rate', '5'));

    /* ---------------------------------------------------- month series --- */

    const [contribByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(contribution_date, '%Y-%m') AS ym,
              COALESCE(SUM(amount), 0) AS total
       FROM contributions
       WHERE status = 'confirmed'
         AND contribution_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), '%Y-%m-01')
       GROUP BY ym`
    );

    const [welfareByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(contribution_date, '%Y-%m') AS ym,
              COALESCE(SUM(amount), 0) AS total
       FROM welfare_contributions
       WHERE status = 'confirmed'
         AND contribution_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), '%Y-%m-01')
       GROUP BY ym`
    );

    const [disbursedByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(disbursement_date, '%Y-%m') AS ym,
              COALESCE(SUM(principal_amount), 0) AS total,
              COALESCE(SUM(interest_amount), 0) AS interest
       FROM loans
       WHERE disbursement_date IS NOT NULL
         AND disbursement_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), '%Y-%m-01')
       GROUP BY ym`
    );

    const [repaidByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(payment_date, '%Y-%m') AS ym,
              COALESCE(SUM(amount), 0) AS total
       FROM loan_repayments
       WHERE payment_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), '%Y-%m-01')
       GROUP BY ym`
    );

    const [expensesByMonth] = await pool.execute(
      `SELECT DATE_FORMAT(expense_date, '%Y-%m') AS ym,
              COALESCE(SUM(amount), 0) AS total
       FROM expenses
       WHERE expense_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), '%Y-%m-01')
       GROUP BY ym`
    );

    // Build a dense 12-month series so gaps render as zero rather than holes.
    const buckets = {};
    for (let i = 11; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      buckets[key] = {
        key,
        label: d.toLocaleDateString('default', { month: 'short' }),
        year: d.getFullYear(),
        contributions: 0,
        welfare: 0,
        loans_disbursed: 0,
        interest_earned: 0,
        repayments: 0,
        expenses: 0,
        cumulative_savings: 0
      };
    }

    const put = (rows, field, extra) => {
      rows.forEach((r) => {
        const b = buckets[r.ym];
        if (!b) return;
        b[field] = Number(r.total);
        if (extra && r[extra.field] !== undefined) b[extra.field] = Number(r[extra.field]);
      });
    };

    put(contribByMonth, 'contributions');
    put(welfareByMonth, 'welfare');
    put(disbursedByMonth, 'loans_disbursed', { field: 'interest_earned' });
    put(repaidByMonth, 'repayments');
    put(expensesByMonth, 'expenses');

    // Savings before this window, so the cumulative line starts from the true total.
    const [carry] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM contributions
       WHERE status = 'confirmed'
         AND contribution_date < DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), '%Y-%m-01')`
    );

    let running = Number(carry[0].total);
    Object.values(buckets).forEach((b) => {
      running += b.contributions;
      b.cumulative_savings = round2(running);
    });

    const monthly = Object.values(buckets);

    /* ---------------------------------------------------------- summary --- */

    const [totals] = await pool.execute(
      `SELECT
         (SELECT COALESCE(SUM(amount), 0) FROM contributions WHERE status = 'confirmed')  AS total_savings,
         (SELECT COALESCE(SUM(amount), 0) FROM welfare_contributions WHERE status = 'confirmed') AS welfare_in,
         (SELECT COALESCE(SUM(amount), 0) FROM expenses)                                        AS total_expenses,
         (SELECT COUNT(*) FROM members WHERE status = 'active')                                AS member_count,
         (SELECT COUNT(*) FROM members
            WHERE joined_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')) AS new_members_month`
    );

    const [interestRows] = await pool.execute(
      `SELECT
         COALESCE(SUM(interest_amount), 0)      AS total_earned,
         COALESCE(SUM(principal_amount), 0)     AS principal_lent
       FROM loans WHERE status IN ('active','completed')`
    );

    const [loanRows] = await pool.execute(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('active','completed') THEN principal_amount ELSE 0 END), 0) AS disbursed,
         COALESCE(SUM(CASE WHEN status IN ('active','disbursed') THEN balance ELSE 0 END), 0)        AS outstanding,
         COALESCE(SUM(CASE WHEN status IN ('active','completed') THEN amount_paid ELSE 0 END), 0)    AS recovered,
         COALESCE(SUM(CASE WHEN status = 'defaulted' THEN balance ELSE 0 END), 0)                    AS defaulted_amount,
         SUM(CASE WHEN status IN ('active','disbursed') THEN 1 ELSE 0 END)                             AS active_count,
         SUM(CASE WHEN status = 'defaulted' THEN 1 ELSE 0 END)                                       AS defaulted_count,
         COUNT(*)                                                                                     AS total_count
       FROM loans`
    );

    const [welfareOut] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM welfare_requests
       WHERE status IN ('approved','disbursed')`
    );

    const t = totals[0];
    const loans = loanRows[0];

    const totalSavings = Number(t.total_savings);
    const thisMonth = monthly[monthly.length - 1]?.contributions || 0;
    const lastMonth = monthly[monthly.length - 2]?.contributions || 0;
    const growthRate =
      lastMonth > 0 ? round2(((thisMonth - lastMonth) / lastMonth) * 100) : 0;

    const interestEarned = Number(interestRows[0].total_earned);
    const interestPayable = round2((totalSavings * savingsRate) / 100);
    const expenses = Number(t.total_expenses);
    const loanLosses = Number(loans.defaulted_amount);
    const netProfit = round2(interestEarned - expenses - loanLosses);

    const disbursed = Number(loans.disbursed);
    const outstanding = Number(loans.outstanding);
    const recovered = Number(loans.recovered);

    res.json({
      summary: {
        total_savings: round2(totalSavings),
        savings_this_month: round2(thisMonth),
        savings_last_month: round2(lastMonth),
        growth_rate: growthRate,
        member_count: Number(t.member_count),
        new_members_this_month: Number(t.new_members_month),
        average_per_member: round2(
          Number(t.member_count) > 0 ? totalSavings / Number(t.member_count) : 0
        )
      },
      interest: {
        rate: loanRate,
        total_earned: round2(interestEarned),
        earned_this_month: round2(
          monthly[monthly.length - 1]?.interest_earned || 0
        ),
        savings_rate: savingsRate,
        payable_to_members: interestPayable,
        net_position: round2(interestEarned - interestPayable)
      },
      profit: {
        income: round2(interestEarned),
        expenses: round2(expenses),
        loan_losses: round2(loanLosses),
        net_profit: netProfit,
        margin: interestEarned > 0 ? round2((netProfit / interestEarned) * 100) : 0
      },
      loans: {
        disbursed: round2(disbursed),
        outstanding: round2(outstanding),
        recovered: round2(recovered),
        recovery_rate: disbursed > 0 ? round2((recovered / disbursed) * 100) : 0,
        active_count: Number(loans.active_count),
        defaulted_count: Number(loans.defaulted_count),
        default_rate: Number(loans.total_count)
          ? round2((Number(loans.defaulted_count) / Number(loans.total_count)) * 100)
          : 0
      },
      welfare: {
        contributed: round2(t.welfare_in),
        disbursed: round2(welfareOut[0].total),
        balance: round2(Number(t.welfare_in) - Number(welfareOut[0].total))
      },
      monthly
    });
  } catch (error) {
    console.error('Growth metrics error:', error);
    res.status(500).json({ error: 'Failed to generate growth metrics.' });
  }
};

/** Members who have not paid, are behind, or have an overdue loan. */
const getReminders = async (req, res) => {
  try {
    const data = await findRiskMembers();
    res.json(data);
  } catch (error) {
    console.error('Reminders error:', error);
    res.status(500).json({ error: 'Failed to load reminders.' });
  }
};

/** Chama growth, interest and profit. */
const getFinancialSummary = async (req, res) => {
  try {
    const [contributions] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) as total FROM contributions WHERE status = 'confirmed'`
    );

    const [loans] = await pool.execute(
      `SELECT COALESCE(SUM(total_repayable), 0) as total_disbursed,
              COALESCE(SUM(balance), 0) as total_outstanding
       FROM loans WHERE status IN ('active', 'disbursed', 'completed')`
    );

    const [welfare] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) as total FROM welfare_contributions WHERE status = 'confirmed'`
    );

    const [members] = await pool.execute(
      `SELECT COUNT(*) as total FROM members WHERE status = 'active'`
    );

    res.json({
      total_contributions: contributions[0].total,
      total_loans_disbursed: loans[0].total_disbursed,
      total_loans_outstanding: loans[0].total_outstanding,
      total_welfare: welfare[0].total,
      active_members: members[0].total
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate report.' });
  }
};

// Monthly report
const getMonthlyReport = async (req, res) => {
  try {
    const { year, month } = req.query;
    const targetYear = year || new Date().getFullYear();
    const targetMonth = month || new Date().getMonth() + 1;

    const [contributions] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
       FROM contributions WHERE status = 'confirmed' AND YEAR(contribution_date) = ? AND MONTH(contribution_date) = ?`,
      [targetYear, targetMonth]
    );

    const [loans] = await pool.execute(
      `SELECT COALESCE(SUM(total_repayable), 0) as total, COUNT(*) as count
       FROM loans WHERE YEAR(application_date) = ? AND MONTH(application_date) = ?`,
      [targetYear, targetMonth]
    );

    const [repayments] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) as total, COUNT(*) as count
       FROM loan_repayments WHERE YEAR(payment_date) = ? AND MONTH(payment_date) = ?`,
      [targetYear, targetMonth]
    );

    res.json({
      period: `${targetYear}-${String(targetMonth).padStart(2, '0')}`,
      contributions: contributions[0],
      loans_approved: loans[0],
      loan_repayments: repayments[0]
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate monthly report.' });
  }
};

// Member statement
const getMemberStatement = async (req, res) => {
  try {
    const { member_id } = req.params;

    const [contributions] = await pool.execute(
      `SELECT * FROM contributions WHERE member_id = ? AND status = 'confirmed' ORDER BY contribution_date DESC`,
      [member_id]
    );

    const [loans] = await pool.execute(
      `SELECT * FROM loans WHERE member_id = ? ORDER BY application_date DESC`,
      [member_id]
    );

    const [repayments] = await pool.execute(
      `SELECT * FROM loan_repayments WHERE member_id = ? ORDER BY payment_date DESC`,
      [member_id]
    );

    res.json({ contributions, loans, repayments });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate statement.' });
  }
};

/* ----------------------------------------------------------- expenses --- */

const getExpenses = async (req, res) => {
  try {
    const [expenses] = await pool.execute(
      `SELECT e.*, a.full_name AS recorded_by_name
       FROM expenses e
       LEFT JOIN admins a ON e.recorded_by = a.id
       ORDER BY e.expense_date DESC, e.id DESC
       LIMIT 200`
    );

    const [totals] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(CASE WHEN expense_date >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01') THEN amount ELSE 0 END), 0) AS this_month
       FROM expenses`
    );

    const [byCategory] = await pool.execute(
      `SELECT category, COALESCE(SUM(amount), 0) AS total
       FROM expenses GROUP BY category ORDER BY total DESC`
    );

    res.json({ expenses, totals: totals[0], by_category: byCategory });
  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json({ error: 'Failed to load expenses.' });
  }
};

const recordExpense = async (req, res) => {
  try {
    const { category, description, amount, expense_date, payment_method, reference_number } = req.body;

    if (!category || !amount || !expense_date) {
      return res.status(400).json({ error: 'Category, amount and date are required.' });
    }
    if (Number(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be greater than zero.' });
    }

    const [result] = await pool.execute(
      `INSERT INTO expenses (category, description, amount, expense_date, payment_method, reference_number, recorded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [category, description || null, amount, expense_date, payment_method || 'cash', reference_number || null, req.user.id]
    );

    res.status(201).json({ success: true, expense_id: result.insertId, message: 'Expense recorded.' });
  } catch (error) {
    console.error('Record expense error:', error);
    res.status(500).json({ error: 'Failed to record expense.' });
  }
};

const deleteExpense = async (req, res) => {
  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM expenses WHERE id = ?', [id]);
    res.json({ success: true, message: 'Expense deleted.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete expense.' });
  }
};

module.exports = {
  getFinancialSummary,
  getMonthlyReport,
  getMemberStatement,
  getGrowthMetrics,
  getReminders,
  getExpenses,
  recordExpense,
  deleteExpense
};
