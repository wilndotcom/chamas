/**
 * Notification templates.
 *
 * Each template is stored in the `settings` table and can contain
 * {{placeholder}} tokens. The token list here is the single source of truth:
 * the Settings screen renders these chips next to each editor, so a placeholder
 * can never be advertised but unsupported.
 */

const PLACEHOLDERS = [
  { token: '{{member_name}}', label: 'Member name', example: 'Achieng Odhiambo' },
  { token: '{{chama_name}}', label: 'Chama name', example: 'THE TEAM' },
  { token: '{{phone}}', label: 'Member phone', example: '0712345678' },
  { token: '{{email}}', label: 'Member email', example: 'achieng@example.com' },
  { token: '{{monthly_contribution}}', label: 'Monthly contribution', example: '1000' },
  { token: '{{reminder_day}}', label: 'Reminder day', example: '5' },
  { token: '{{paybill}}', label: 'M-Pesa paybill', example: '600000' },
  { token: '{{loan_amount}}', label: 'Loan principal', example: '10000' },
  { token: '{{balance}}', label: 'Outstanding balance', example: '5500' },
  { token: '{{amount_due}}', label: 'Amount due now', example: '5500' },
  { token: '{{total_repayable}}', label: 'Total repayable', example: '11000' },
  { token: '{{interest}}', label: 'Interest amount', example: '1000' },
  { token: '{{interest_rate}}', label: 'Interest rate %', example: '10' },
  { token: '{{due_date}}', label: 'Loan due date', example: '15 Jan 2027' },
  { token: '{{days_left}}', label: 'Days until due', example: '3' },
  { token: '{{application_date}}', label: 'Loan applied on', example: '4 Oct 2026' },
  { token: '{{loan_status}}', label: 'Loan status', example: 'pending' }
];

const TEMPLATES = [
  {
    key: 'tpl_account_created',
    label: 'Account created',
    description: 'Sent to a member once an admin approves their registration.',
    default:
      'Hello {{member_name}}, your {{chama_name}} membership has been approved. You can now log in with {{phone}}. Your monthly contribution is KES {{monthly_contribution}}, payable by the {{reminder_day}} of each month.'
  },
  {
    key: 'tpl_welcome',
    label: 'Welcome message',
    description: 'Sent after approval to welcome the member and explain how to pay.',
    default:
      'Welcome to {{chama_name}}, {{member_name}}! We are glad to have you. Please pay your monthly contribution of KES {{monthly_contribution}} by the {{reminder_day}} of every month using M-Pesa paybill {{paybill}}. Kindly confirm receipt with the treasurer.'
  },
  {
    key: 'tpl_loan_due',
    label: 'Loan due date',
    description: 'Sent on the due date itself.',
    default:
      '{{member_name}}, your {{chama_name}} loan of KES {{balance}} falls due today, {{due_date}}. Please pay KES {{amount_due}} on time. Thank you.'
  },
  {
    key: 'tpl_due_7days',
    label: '7 days before due date',
    description: 'Early warning so the member can plan.',
    default:
      'Reminder: {{member_name}}, your loan of KES {{balance}} is due in 7 days on {{due_date}}. Please begin arranging KES {{amount_due}}.'
  },
  {
    key: 'tpl_due_3days',
    label: '3 days before due date',
    description: 'Second and more urgent reminder.',
    default:
      'Final reminder: {{member_name}}, your {{chama_name}} loan of KES {{balance}} is due in 3 days on {{due_date}}. Outstanding amount is KES {{amount_due}}.'
  },
  {
    key: 'tpl_due_1day',
    label: '1 day before due date',
    description: 'Last warning before the due date.',
    default:
      'Last day: {{member_name}}, your loan of KES {{balance}} is due TOMORROW, {{due_date}}. Please pay KES {{amount_due}} today to avoid penalties.'
  }
];

/** Replaces {{token}} with values, leaving unknown tokens visible for debugging. */
const render = (text, data = {}) => {
  if (!text) return '';
  return String(text).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    const value = data[key];
    if (value === undefined || value === null || value === '') return match;
    return String(value);
  });
};

/** Tokens used in a given template body that we do not recognise. */
const unknownTokens = (text) => {
  const known = new Set(PLACEHOLDERS.map((p) => p.token.replace(/[{}]/g, '')));
  const found = new Set();
  String(text || '').replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    if (!known.has(key)) found.add(`{{${key}}}`);
    return match;
  });
  return [...found];
};

/** Realistic sample values so preview and test output look like production. */
const sampleData = {
  member_name: 'Achieng Odhiambo',
  chama_name: 'THE TEAM',
  phone: '0712345678',
  email: 'achieng@example.com',
  monthly_contribution: '1000',
  reminder_day: '5',
  paybill: '600000',
  loan_amount: '10000',
  balance: '5500',
  amount_due: '5500',
  total_repayable: '11000',
  interest: '1000',
  interest_rate: '10',
  due_date: '15 Jan 2027',
  days_left: '3',
  application_date: '4 Oct 2026',
  loan_status: 'pending'
};

const templatesWithDefaults = () =>
  TEMPLATES.map((t) => ({
    ...t,
    placeholders: PLACEHOLDERS
  }));

module.exports = {
  PLACEHOLDERS,
  TEMPLATES,
  templatesWithDefaults,
  render,
  unknownTokens,
  sampleData
};