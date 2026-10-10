/**
 * Detects members who need chasing.
 *
 * Used by the dashboard widget and by the reminder sender so the two can never
 * disagree about who is behind.
 */

const pool = require('../config/database');

const getSetting = async (key, fallback = null) => {
  const [rows] = await pool.execute(
    'SELECT setting_value FROM settings WHERE setting_key = ?',
    [key]
  );
  return rows.length ? rows[0].setting_value : fallback;
};

const monthKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const monthsBetween = (fromDate, toDate) => {
  const a = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
  const b = new Date(toDate.getFullYear(), toDate.getMonth(), 1);
  let months = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  // Not yet a full month has passed since the last payment.
  if (toDate.getDate() < fromDate.getDate()) months -= 1;
  return Math.max(0, months);
};

const todayISO = () => new Date().toISOString().slice(0, 10);

/**
 * @returns {Promise<{month:string, monthlyAmount:number, members:Array, summary:object}>}
 */
const findRiskMembers = async () => {
  const now = new Date();
  const currentMonth = monthKey(now);
  const today = todayISO();

  const monthlyContribution = Number(await getSetting('monthly_contribution', '1000'));

  const [rows] = await pool.execute(
    `SELECT
       m.id, m.full_name, m.phone, m.email, m.joined_date,
       (SELECT MAX(contribution_date) FROM contributions c
         WHERE c.member_id = m.id AND c.status = 'confirmed')            AS last_contribution,
       (SELECT COALESCE(SUM(amount), 0) FROM contributions c
         WHERE c.member_id = m.id AND c.status = 'confirmed')            AS total_contributed,
       (SELECT COUNT(*) FROM contributions c
         WHERE c.member_id = m.id AND c.status = 'confirmed'
           AND DATE_FORMAT(contribution_date, '%Y-%m') = ?)              AS paid_this_month,
       (SELECT COALESCE(SUM(balance), 0) FROM loans l
         WHERE l.member_id = m.id AND l.status IN ('active','disbursed'))  AS loan_balance,
       (SELECT MIN(due_date) FROM loans l
         WHERE l.member_id = m.id AND l.status IN ('active','disbursed')
           AND l.balance > 0)                                             AS loan_due_date,
       (SELECT COALESCE(SUM(balance), 0) FROM loans l
         WHERE l.member_id = m.id AND l.status = 'defaulted')             AS defaulted_amount
     FROM members m
     WHERE m.status = 'active'
     ORDER BY m.full_name`,
    [currentMonth]
  );

  const members = [];

  for (const row of rows) {
    // A brand new member is not chased before the group has had a chance to collect.
    const joined = new Date(row.joined_date);
    const monthsSinceJoin = monthsBetween(joined, now);
    if (monthsSinceJoin <= 0 && Number(row.paid_this_month) === 0) continue;

    const lastPaid = row.last_contribution ? new Date(row.last_contribution) : joined;
    const monthsMissed = monthsBetween(lastPaid, now);
    const notPaidThisMonth = Number(row.paid_this_month) === 0;

    const loanBalance = Number(row.loan_balance);
    const loanOverdue = !!row.loan_due_date && row.loan_due_date < today && loanBalance > 0;
    const daysOverdue = loanOverdue
      ? Math.floor((now - new Date(row.loan_due_date)) / 86400000)
      : 0;
    const defaulted = Number(row.defaulted_amount) > 0;

    if (!notPaidThisMonth && !loanOverdue && !defaulted) continue;

    // Worst problem decides the headline reason.
    let reason = 'on_track';
    let severity = 'low';
    let detail = '';
    let amount = 0;

    if (defaulted) {
      reason = 'defaulted_loan';
      severity = 'critical';
      amount = Number(row.defaulted_amount);
      detail = `Has a defaulted loan of KES ${amount.toLocaleString()}`;
    } else if (loanOverdue) {
      reason = 'overdue_loan';
      severity = daysOverdue > 30 ? 'critical' : 'high';
      amount = loanBalance;
      detail = `Loan of KES ${loanBalance.toLocaleString()} was due ${row.loan_due_date} (${daysOverdue} days ago)`;
    } else if (notPaidThisMonth && monthsMissed >= 2) {
      reason = 'missed_contributions';
      severity = 'high';
      amount = monthlyContribution * monthsMissed;
      detail = `Has not contributed for ${monthsMissed} months`;
    } else if (notPaidThisMonth) {
      reason = 'not_paid';
      severity = 'medium';
      amount = monthlyContribution;
      detail = 'Has not contributed this month';
    } else if (notPaidThisMonth === false && monthsMissed >= 1) {
      reason = 'missed_contributions';
      severity = 'medium';
      amount = monthlyContribution * monthsMissed;
      detail = `Last contribution was ${row.last_contribution}`;
    }

    // Loan arrears outrank a missed contribution for the headline figure.
    if (reason === 'missed_contributions' && loanBalance > 0) {
      detail += ` · also owes KES ${loanBalance.toLocaleString()} on a loan`;
    }

    members.push({
      member_id: row.id,
      full_name: row.full_name,
      phone: row.phone,
      email: row.email,
      last_contribution: row.last_contribution,
      months_missed: monthsMissed,
      reason,
      severity,
      detail,
      amount,
      loan_balance: loanBalance,
      loan_due_date: row.loan_due_date,
      days_overdue: daysOverdue
    });
  }

  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  members.sort((a, b) => rank[a.severity] - rank[b.severity] || b.amount - a.amount);

  const summary = {
    not_paid: members.filter((m) => m.reason === 'not_paid').length,
    missed_contributions: members.filter((m) => m.reason === 'missed_contributions').length,
    overdue_loans: members.filter((m) => m.reason === 'overdue_loan').length,
    defaulted: members.filter((m) => m.reason === 'defaulted_loan').length,
    total: members.length,
    total_amount: members.reduce((sum, m) => sum + m.amount, 0)
  };

  return { month: currentMonth, monthlyAmount: monthlyContribution, members, summary };
};

/** Builds the reminder text for one member. */
const buildReminderMessage = (member, opts = {}) => {
  const chama = opts.chamaName || 'THE TEAM';
  const amount = opts.monthlyAmount || 0;
  const date = opts.today || todayISO();

  if (member.reason === 'defaulted_loan') {
    return `${chama}: Hello ${member.full_name}, our records show a defaulted loan balance of KES ${member.amount.toLocaleString()}. Please contact the office to settle it.`;
  }

  if (member.reason === 'overdue_loan') {
    return `${chama}: Hello ${member.full_name}, your loan balance of KES ${member.amount.toLocaleString()} was due on ${member.loan_due_date} (${member.days_overdue} days ago). Please arrange repayment.`;
  }

  const months = member.months_missed > 1 ? `${member.months_missed} months` : 'this month';
  const owed = amount ? ` (KES ${amount.toLocaleString()})` : '';

  return `${chama}: Dear ${member.full_name}, this is a friendly reminder that your contribution for ${months}${owed} has not been received. Kindly pay via M-Pesa. Thank you.`;
};

module.exports = { findRiskMembers, buildReminderMessage, getSetting, monthKey };