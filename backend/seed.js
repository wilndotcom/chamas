/**
 * Seed script for THE TEAM
 * Creates the super admin and optional demo data.
 * Run: node seed.js
 *
 * On a server, run it with NODE_ENV=production so it targets the real database:
 *   NODE_ENV=production node seed.js
 */
require('./config/env');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const DB = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'the_team_chama'
};

/**
 * The password every administrator account is created with.
 *
 * This used to be the literal string 'admin123', written into each account
 * below. That is a working login on any install seeded with it, and this
 * repository is published - so anybody who read the source knew how to sign in
 * to a running chama.
 *
 * It now comes from the environment, and is generated when it is not set.
 * There is deliberately no fallback value: a fallback would have to live in
 * this file, and this file is published.
 *
 *   Unix:                  ADMIN_PASSWORD=... node seed.js
 *   PowerShell:            $env:ADMIN_PASSWORD='...'; node seed.js
 *
 * The checks under backend-php read ADMIN_PASSWORD too, so that they can sign
 * in without carrying a password in the published source. The running app
 * never needs it: what it stores and compares is the hash in the database.
 *
 * Accounts created here are flagged must_change_password, so this password is a
 * way in and not a way to stay in: the app refuses everything except the change
 * of password itself until it has been replaced. That is what makes a shared,
 * guessable starting password acceptable at all - and the flag is set below, in
 * the same row as the password, so the two cannot drift apart.
 */
function randomPassword() {
  // Look-alike characters are left out, because this gets read off a screen
  // and typed in by hand. The length makes up for the smaller alphabet, and
  // for far more than it needs to.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = require('crypto').randomBytes(20);

  let out = '';
  for (let i = 0; i < 20; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }

  // Grouped, so it can be read out loud across a room without losing a place.
  return `${out.slice(0, 6)}-${out.slice(6, 12)}-${out.slice(12, 18)}`;
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || randomPassword();
const ADMIN_PASSWORD_WAS_GENERATED = !process.env.ADMIN_PASSWORD;

const SUPER_ADMIN = {
  full_name: 'Super Admin',
  // Sign-in identifiers. Either one works, plus the email below.
  username: 'admin',
  email: 'admin@theteam.com',
  phone: '0712345678',
  password: ADMIN_PASSWORD
};

const DEMO_ADMINS = [
  { full_name: 'Jane Treasurer', username: 'treasurer', email: 'treasurer@theteam.com', phone: '0722000001', password: ADMIN_PASSWORD, role: 'treasurer' },
  { full_name: 'Peter Chairperson', username: 'chair', email: 'chair@theteam.com', phone: '0722000002', password: ADMIN_PASSWORD, role: 'chairperson' },
  { full_name: 'Grace Secretary', username: 'secretary', email: 'secretary@theteam.com', phone: '0722000003', password: ADMIN_PASSWORD, role: 'secretary' }
];

const DEMO_MEMBERS = [
  { full_name: 'Mary Wanjiku', email: 'mary@example.com', phone: '0711000001', password: 'member123', joined_months_ago: 9 },
  { full_name: 'John Otieno', email: 'john@example.com', phone: '0711000002', password: 'member123', joined_months_ago: 8 },
  { full_name: 'Alice Achieng', email: 'alice@example.com', phone: '0711000003', password: 'member123', joined_months_ago: 7 },
  { full_name: 'David Mwangi', email: 'david@example.com', phone: '0711000004', password: 'member123', joined_months_ago: 5 },
  { full_name: 'Esther Njeri', email: 'esther@example.com', phone: '0711000005', password: 'member123', joined_months_ago: 2 }
];

async function run() {
  const conn = await mysql.createConnection(DB);
  console.log('Connected to MySQL');

  const hash = await bcrypt.hash(SUPER_ADMIN.password, 12);

  // Super admin
  await conn.execute(
    `INSERT INTO admins (full_name, username, email, phone, password_hash, role_id, must_change_password)
     VALUES (?, ?, ?, ?, ?, 1, 1)
     ON DUPLICATE KEY UPDATE
       username = VALUES(username),
       password_hash = VALUES(password_hash),
       must_change_password = 1,
       is_active = TRUE`,
    [SUPER_ADMIN.full_name, SUPER_ADMIN.username, SUPER_ADMIN.email, SUPER_ADMIN.phone, hash]
  );
  if (ADMIN_PASSWORD_WAS_GENERATED) {
    // Shown once and stored nowhere. If this scrolls past unread, the way back
    // in is to run the seed again with ADMIN_PASSWORD set.
    console.log('');
    console.log('  No ADMIN_PASSWORD was set, so one has been generated. This is the only');
    console.log('  time it is shown - it is not written to .env or to any file.');
    console.log('');
    console.log(`      ${ADMIN_PASSWORD}`);
    console.log('');
  }

  console.log(`Super admin ready: ${SUPER_ADMIN.username} or ${SUPER_ADMIN.email}`);

  // Ensure the impersonation flag exists for databases seeded before it was added
  await conn.execute(
    `INSERT IGNORE INTO settings (setting_key, setting_value, description)
     VALUES ('allow_impersonation', '1', 'Allow super admin to view portals as another member or admin')`
  );

  // Demo admins
  for (const a of DEMO_ADMINS) {
    const h = await bcrypt.hash(a.password, 12);
    const [rows] = await conn.execute('SELECT id FROM roles WHERE name = ?', [a.role]);
    await conn.execute(
      `INSERT INTO admins (full_name, username, email, phone, password_hash, role_id, must_change_password)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         username = VALUES(username),
         password_hash = VALUES(password_hash),
         role_id = VALUES(role_id),
         must_change_password = 1,
         is_active = TRUE`,
      [a.full_name, a.username, a.email, a.phone, h, rows[0].id]
    );
  }
  console.log(`Demo admins ready (${DEMO_ADMINS.length}), on the same password as the super admin`);
  console.log('They must choose their own password at first sign-in.');

  // Backfill a username for any admin added before this feature existed, so a
  // login screen that says "username" is not a lie for upgraded installs.
  // Skipped when the suggested name is already taken by someone else.
  const [adopted] = await conn.execute(
    `SELECT a.id, SUBSTRING_INDEX(a.email, '@', 1) AS suggested
     FROM admins a
     WHERE a.username IS NULL OR a.username = ''`
  );
  let backfilled = 0;
  for (const { id, suggested } of adopted) {
    const base = String(suggested).toLowerCase().replace(/[^a-z0-9._-]/g, '') || 'admin';
    let candidate = base;
    let n = 1;
    for (;;) {
      const [taken] = await conn.execute(
        'SELECT 1 FROM admins WHERE username = ? AND id <> ? LIMIT 1',
        [candidate, id]
      );
      if (taken.length === 0) break;
      candidate = `${base}${++n}`;
    }
    await conn.execute('UPDATE admins SET username = ? WHERE id = ?', [candidate, id]);
    backfilled += 1;
  }
  if (backfilled) console.log(`Usernames backfilled for ${backfilled} existing admin(s)`);

  // Demo members
  for (const m of DEMO_MEMBERS) {
    const h = await bcrypt.hash(m.password, 12);
    // Stagger join dates so "months behind" logic has something to work with.
    const joined = new Date();
    joined.setMonth(joined.getMonth() - m.joined_months_ago);
    await conn.execute(
      `INSERT INTO members (full_name, email, phone, password_hash, joined_date)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash),
                               status = 'active',
                               joined_date = VALUES(joined_date)`,
      [m.full_name, m.email, m.phone, h, joined.toISOString().slice(0, 10)]
    );
  }
  console.log(`Demo members ready (${DEMO_MEMBERS.length})`);

  // Demo contributions
  const [members] = await conn.execute('SELECT id, full_name FROM members');
  const [existingContrib] = await conn.execute('SELECT COUNT(*) AS c FROM contributions');
  if (existingContrib[0].c === 0) {
    for (const m of members) {
      for (let i = 1; i <= 3; i++) {
        const d = new Date();
        d.setMonth(d.getMonth() - i);
        await conn.execute(
          `INSERT INTO contributions (member_id, amount, contribution_date, payment_method, status)
           VALUES (?, 1000, ?, 'mpesa_stk', 'confirmed')`,
          [m.id, d.toISOString().slice(0, 10)]
        );
      }
    }
    console.log('Demo contributions created (3 months x all members)');

    // All but the last two members have paid this month, so the reminders
    // widget shows a realistic mix instead of flagging everybody.
    const paidThisMonth = members.slice(0, Math.max(0, members.length - 2));
    for (const m of paidThisMonth) {
      await conn.execute(
        `INSERT INTO contributions (member_id, amount, contribution_date, payment_method, status)
         VALUES (?, 1000, CURDATE(), 'mpesa_stk', 'confirmed')`,
        [m.id]
      );
    }
    console.log(`Demo: ${paidThisMonth.length} paid this month, ${members.length - paidThisMonth.length} left behind on purpose`);
  }

  // Demo loans, so the growth/profit widgets have meaningful figures.
  // Mix of statuses also populates the pending-approvals widget.
  const [existingLoans] = await conn.execute('SELECT COUNT(*) AS c FROM loans');
  if (existingLoans[0].c === 0 && members.length >= 4) {
    const mkLoan = async (memberId, principal, paid, status, purpose, dueInMonths) => {
      const interest = Math.round(principal * 0.1);
      const total = principal + interest;
      const [res] = await conn.execute(
        `INSERT INTO loans (member_id, principal_amount, interest_rate, interest_amount, total_repayable,
           amount_paid, balance, status, purpose, application_date, approval_date, disbursement_date,
           due_date, approved_by)
         VALUES (?, ?, 10, ?, ?, ?, ?, ?, ?, DATE_SUB(CURDATE(), INTERVAL 2 MONTH), DATE_SUB(CURDATE(), INTERVAL 2 MONTH),
           ${status === 'pending' ? 'NULL' : 'DATE_SUB(CURDATE(), INTERVAL 2 MONTH)'},
           DATE_ADD(CURDATE(), INTERVAL ? MONTH), 1)`,
        [memberId, principal, interest, total, paid, total - paid, status, purpose, dueInMonths]
      );

      // Back the repayments behind amount_paid, otherwise the cash book shows
      // money lent out that never came back.
      if (paid > 0) {
        const when = status === 'completed'
          ? 'DATE_SUB(CURDATE(), INTERVAL 1 MONTH)'
          : 'DATE_SUB(CURDATE(), INTERVAL 3 WEEK)';
        await conn.execute(
          `INSERT INTO loan_repayments (loan_id, member_id, amount, payment_date, payment_method, recorded_by)
           VALUES (?, ?, ?, ${when}, 'mpesa_stk', 1)`,
          [res.insertId, memberId, paid]
        );
      }
    };

    // Fully repaid: shows interest already banked
    await mkLoan(members[0].id, 8000, 8800, 'completed', 'School fees', 1);
    // Partly repaid: shows outstanding balance
    await mkLoan(members[1].id, 5000, 2000, 'active', 'Business capital', 3);
    // Freshly disbursed: shows interest accrued but unpaid
    await mkLoan(members[2].id, 10000, 0, 'active', 'Land purchase deposit', 3);
    // Waiting for approval: populates the pending widget
    await mkLoan(members[3].id, 3000, 0, 'pending', 'Emergency medical bill', 3);

    console.log('Demo loans created (4: 1 completed, 2 active, 1 pending) + repayments');
  }

  // Demo expenses, so the profit widget has real figures to work with
  const [existingExpenses] = await conn.execute('SELECT COUNT(*) AS c FROM expenses');
  if (existingExpenses[0].c === 0) {
    const rows = [
      ['Stationery', 'Ledger books and printing', 450, -2],
      ['Transport', 'Collecting contributions', 250, -1],
      ['Bank charges', 'Account fees', 200, -1],
      ['Meeting costs', 'Refreshments for monthly meeting', 400, 0],
      ['Mobile money charges', 'M-Pesa transaction fees', 150, 0]
    ];
    for (const [category, description, amount, monthOffset] of rows) {
      const d = new Date();
      d.setMonth(d.getMonth() + monthOffset);
      await conn.execute(
        `INSERT INTO expenses (category, description, amount, expense_date, payment_method, recorded_by)
         VALUES (?, ?, ?, ?, 'cash', 1)`,
        [category, description, amount, d.toISOString().slice(0, 10)]
      );
    }
    console.log('Demo expenses created (5)');
  }

  await conn.end();
  console.log('\nSeed complete.');
}

run().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});