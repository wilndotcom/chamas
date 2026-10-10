const pool = require('../config/database');

/** Reads one setting, falling back when the key is absent. */
const getSetting = async (key, fallback = null) => {
  const [rows] = await pool.execute(
    'SELECT setting_value FROM settings WHERE setting_key = ?',
    [key]
  );
  return rows.length ? rows[0].setting_value : fallback;
};

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Builds a dense month series so the chart shows zero for a quiet month rather
 * than skipping it, which reads as missing data rather than as "nothing happened".
 */
const lastTwelveMonths = () => {
  const buckets = {};
  for (let i = 11; i >= 0; i--) {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets[key] = {
      key,
      label: d.toLocaleString('en', { month: 'short' }),
      savings_in: 0,
      welfare_in: 0,
      welfare_out: 0,
      interest_earned: 0,
      expenses: 0
    };
  }
  return buckets;
};

/**
 * What the member portal shows about the group as a whole.
 *
 * The figures are deliberately split into two groups that are easy to confuse:
 *
 *   held for members  savings and welfare balances. This is the members' own
 *                     money, and the group owes it back. It is a liability, not
 *                     profit, and adding it to profit would tell members their
 *                     own savings had been earned by the group.
 *
 *   the group's own   interest collected on loans, less running costs. This is
 *                     the only genuine income, and it is what "profit" means
 *                     here.
 *
 * Loans already disbursed are shown separately again as a receivable: the cash
 * has left but is not spent, so counting it as an expense would understate the
 * group and overstate profit.
 */
const getTransparency = async (req, res) => {
  try {
    const memberId = req.user.id;

    /* ------------------------------------------------------ held for members --- */

    const [[savings]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS held
         FROM contributions WHERE status = 'confirmed'`
    );

    const [[welfareIn]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM welfare_contributions WHERE status = 'confirmed'`
    );
    const [[welfareOut]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM welfare_requests WHERE status = 'disbursed'`
    );
    const welfareAvailable = round2(Number(welfareIn.total) - Number(welfareOut.total));

    /* ------------------------------------------------------ loans and income --- */

    const [[loans]] = await pool.execute(
      `SELECT COALESCE(SUM(principal_amount), 0) AS disbursed,
              COALESCE(SUM(interest_amount), 0)    AS interest_charged
         FROM loans WHERE disbursement_date IS NOT NULL`
    );

    const [[repaid]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM loan_repayments`
    );

    // Interest actually collected, not interest charged. Charging an interest on
    // paper is not income; only what came back is.
    const [[interestCollected]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total
         FROM loan_repayments`
    );

    const [[expenses]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses`
    );

    // Money physically in the bank: everything received, less everything paid out.
    const [[moneyIn]] = await pool.execute(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE 0 END), 0) AS total_in,
              COALESCE(SUM(CASE WHEN direction = 'out' THEN amount ELSE 0 END), 0) AS total_out
         FROM ledger_entries`
    );
    const [[contribTotal]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM contributions WHERE status = 'confirmed'`
    );

    const cashOnHand = round2(
      Number(contribTotal.total) +
      Number(welfareIn.total) +
      Number(moneyIn.total_in) -
      Number(welfareOut.total) -
      Number(moneyIn.total_out)
    );

    const disbursedTotal = Number(loans.disbursed);
    const repaidTotal = Number(repaid.total);
    const receivable = round2(disbursedTotal - repaidTotal);
    const expensesTotal = Number(expenses.total);
    const incomeTotal = Number(interestCollected.total);
    const profit = round2(incomeTotal - expensesTotal);

    /* ------------------------------------------------------------ month series --- */

    const buckets = lastTwelveMonths();
    const since = 'DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), \'%Y-%m-01\')';

    const [savingsSeries] = await pool.execute(
      `SELECT DATE_FORMAT(contribution_date, '%Y-%m') AS ym,
              COALESCE(SUM(amount), 0) AS total
         FROM contributions
        WHERE status = 'confirmed' AND contribution_date >= ${since}
        GROUP BY ym`
    );
    const [welfareSeries] = await pool.execute(
      `SELECT DATE_FORMAT(contribution_date, '%Y-%m') AS ym,
              COALESCE(SUM(amount), 0) AS total
         FROM welfare_contributions
        WHERE status = 'confirmed' AND contribution_date >= ${since}
        GROUP BY ym`
    );
    const [repaySeries] = await pool.execute(
      `SELECT DATE_FORMAT(payment_date, '%Y-%m') AS ym,
              COALESCE(SUM(amount), 0) AS total
         FROM loan_repayments
        WHERE payment_date >= ${since}
        GROUP BY ym`
    );
    const [expenseSeries] = await pool.execute(
      `SELECT DATE_FORMAT(expense_date, '%Y-%m') AS ym,
              COALESCE(SUM(amount), 0) AS total
         FROM expenses
        WHERE expense_date >= ${since}
        GROUP BY ym`
    );

    for (const r of savingsSeries) if (buckets[r.ym]) buckets[r.ym].savings_in = round2(r.total);
    for (const r of welfareSeries) if (buckets[r.ym]) buckets[r.ym].welfare_in = round2(r.total);
    for (const r of repaySeries) if (buckets[r.ym]) buckets[r.ym].interest_earned = round2(r.total);
    for (const r of expenseSeries) if (buckets[r.ym]) buckets[r.ym].expenses = round2(r.total);

    /* ------------------------------------------------------- other members --- */

    // Contributions and loans per member, so a member can see how the group is
    // really doing rather than only their own row. Names and totals only, never
    // a member's password or id number.
    const [members] = await pool.execute(
      `SELECT
         m.id,
         m.full_name,
         -- Admins are members too (migration 016), so they appear here like
         -- anyone else. Flagged rather than hidden.
         CASE WHEN a.id IS NULL THEN 0 ELSE 1 END AS is_admin,
         COALESCE(c.total, 0)   AS savings_total,
         COALESCE(wc.total, 0)  AS welfare_total,
         COALESCE(l.outstanding, 0) AS loan_balance,
         m.joined_date
       FROM members m
       LEFT JOIN admins a ON a.member_id = m.id
       LEFT JOIN (
         SELECT member_id, SUM(amount) AS total
           FROM contributions WHERE status = 'confirmed' GROUP BY member_id
       ) c ON c.member_id = m.id
       LEFT JOIN (
         SELECT member_id, SUM(amount) AS total
           FROM welfare_contributions WHERE status = 'confirmed' GROUP BY member_id
       ) wc ON wc.member_id = m.id
       LEFT JOIN (
         SELECT member_id,
                SUM(principal_amount + interest_amount - COALESCE(paid, 0)) AS outstanding
           FROM (
             SELECT l.member_id, l.principal_amount, l.interest_amount,
                    COALESCE((SELECT SUM(r.amount) FROM loan_repayments r
                               WHERE r.loan_id = l.id), 0) AS paid
               FROM loans l
              WHERE l.disbursement_date IS NOT NULL
                AND l.status IN ('approved', 'active', 'disbursed')
           ) x GROUP BY member_id
       ) l ON l.member_id = m.id
      WHERE m.status = 'active'
      ORDER BY m.full_name`
    );

    /* ----------------------------------------------------------- own position --- */

    const [[own]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS savings FROM contributions
        WHERE member_id = ? AND status = 'confirmed'`,
      [memberId]
    );
    const [[ownWelfare]] = await pool.execute(
      `SELECT COALESCE(SUM(amount), 0) AS welfare FROM welfare_contributions
        WHERE member_id = ? AND status = 'confirmed'`,
      [memberId]
    );
    const [[ownLoan]] = await pool.execute(
      `SELECT COALESCE(SUM(principal_amount + interest_amount), 0) AS owed
         FROM loans WHERE member_id = ? AND disbursement_date IS NOT NULL
           AND status IN ('approved', 'active', 'disbursed')`,
      [memberId]
    );
    const [[ownPaid]] = await pool.execute(
      `SELECT COALESCE(SUM(r.amount), 0) AS paid
         FROM loan_repayments r
         JOIN loans l ON l.id = r.loan_id
        WHERE l.member_id = ?`,
      [memberId]
    );

    res.json({
      /*
       * What the members collectively own. Shown first because it is the number
       * that belongs to the people reading the screen.
       */
      held_for_members: {
        savings: round2(savings.held),
        welfare: welfareAvailable,
        total: round2(Number(savings.held) + welfareAvailable)
      },

      /*
       * What the group itself holds, split so the two are never added together
       * into one misleading headline.
       */
      group_position: {
        cash_on_hand: cashOnHand,
        receivable_from_members: receivable,
        net_worth: round2(cashOnHand + receivable),
        note:
          'Member savings and welfare are member money held on trust. ' +
          'They are not profit.'
      },

      income: {
        interest_collected: round2(incomeTotal),
        expenses: round2(expensesTotal),
        profit,
        note: 'Interest on loans is the only income the group earns.'
      },

      loans: {
        disbursed: round2(disbursedTotal),
        repaid: round2(repaidTotal),
        outstanding: receivable
      },

      member_count: members.length,

      series: Object.values(buckets),

      // Names and totals only: a member can see how the group is doing, not
      // another member's credentials.
      members,

      me: {
        member_id: memberId,
        savings: round2(own.savings),
        welfare: round2(ownWelfare.welfare),
        loan_balance: round2(Number(ownLoan.owed) - Number(ownPaid.paid))
      },

      chama_name: await getSetting('chama_name', 'THE TEAM')
    });
  } catch (error) {
    console.error('Transparency error:', error);
    res.status(500).json({ error: 'Failed to load the group figures.' });
  }
};

module.exports = { getTransparency };