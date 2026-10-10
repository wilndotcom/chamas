/**
 * Loan arithmetic shared by the member portal, the dashboard and reports.
 *
 * Flat-interest chama loans charge one interest figure on the principal for the
 * whole term. Repayments arrive as single amounts with no split recorded, so the
 * interest still outstanding is derived pro rata: the remaining balance keeps
 * the same share of interest it had when the loan was written.
 *
 *     interest_outstanding = balance / total_repayable * interest_charged
 *
 * It is an estimate, and is labelled as one in the UI rather than presented as
 * a separate ledger, because the system does not record which part of each
 * repayment cleared interest.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Normalises a date column to a plain YYYY-MM-DD string.
 *
 * mysql2 hands DATE columns back as JS Date objects in local time, so calling
 * toISOString() would shift the day for anyone east or west of UTC. Formatting
 * from the local components keeps the calendar date the database actually holds.
 */
const dateOnly = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/** Adds the interest/principal breakdown to a loan row. */
const decorateLoan = (row) => {
  const principal = Number(row.principal_amount);
  const interest = Number(row.interest_amount);
  const total = Number(row.total_repayable);
  const paid = Number(row.amount_paid);
  const balance = Number(row.balance);

  const interestOutstanding = total > 0 ? round2((balance / total) * interest) : 0;
  const principalOutstanding = round2(Math.max(0, balance - interestOutstanding));
  const repaidPct = total > 0 ? Math.min(100, round2((paid / total) * 100)) : 0;

  const open = ['approved', 'active', 'disbursed'].includes(row.status);
  const settled = ['completed'].includes(row.status);

  const applicationDate = dateOnly(row.application_date);
  const approvalDate = dateOnly(row.approval_date);
  const disbursementDate = dateOnly(row.disbursement_date);
  const dueDate = dateOnly(row.due_date);

  let daysToDue = null;
  if (dueDate) {
    const due = new Date(`${dueDate}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (!Number.isNaN(due.getTime())) {
      daysToDue = Math.round((due - today) / 86400000);
    }
  }

  return {
    ...row,
    application_date: applicationDate,
    approval_date: approvalDate,
    disbursement_date: disbursementDate,
    due_date: dueDate,
    principal_amount: round2(principal),
    interest_amount: round2(interest),
    total_repayable: round2(total),
    amount_paid: round2(paid),
    balance: round2(balance),
    interest_outstanding: settled ? 0 : interestOutstanding,
    principal_outstanding: settled ? 0 : principalOutstanding,
    repaid_percent: settled ? 100 : repaidPct,
    is_open: open,
    is_settled: settled,
    days_to_due: daysToDue,
    is_overdue: !!(open && daysToDue !== null && daysToDue < 0)
  };
};

/** Totals across several loans, for the member dashboard summary. */
const summarise = (loans) => {
  const open = (loans || []).filter((l) => l.is_open);
  const sum = (key) => round2(open.reduce((t, l) => t + Number(l[key] || 0), 0));

  const balance = sum('balance');
  const interestOutstanding = sum('interest_outstanding');
  const principalOutstanding = sum('principal_outstanding');
  const totalRepayable = round2(
    open.reduce((t, l) => t + Number(l.total_repayable || 0), 0)
  );
  const amountPaid = round2(
    open.reduce((t, l) => t + Number(l.amount_paid || 0), 0)
  );

  // Nearest due date across open loans, so the member sees one clear deadline.
  const dues = open
    .filter((l) => l.days_to_due !== null && l.days_to_due !== undefined)
    .map((l) => l.days_to_due);
  const daysToDue = dues.length ? Math.min(...dues) : null;

  return {
    open_loan_count: open.length,
    settled_loan_count: (loans || []).filter((l) => l.is_settled).length,
    total_balance: balance,
    principal_outstanding: principalOutstanding,
    interest_outstanding: interestOutstanding,
    amount_paid: amountPaid,
    total_repayable: totalRepayable,
    repaid_percent: totalRepayable > 0
      ? Math.min(100, round2((amountPaid / totalRepayable) * 100))
      : 0,
    next_due_date: open
      .filter((l) => l.due_date)
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))[0]?.due_date || null,
    days_to_due: daysToDue,
    is_overdue: !!(daysToDue !== null && daysToDue < 0)
  };
};

module.exports = { decorateLoan, summarise, round2, dateOnly };