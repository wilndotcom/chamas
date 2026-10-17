# THE TEAM - Chama Management System

A comprehensive Chama (savings and credit group) management system with admin and member portals, M-Pesa integration, and multi-channel notifications.

## Features

### Admin Portal
- Role-based access control (Super Admin, Treasurer, Chairperson, Secretary, Admin)
- Member management (add, edit, deactivate or remove)
- Contribution tracking and recording
- Loan application approval and disbursement
- Welfare fund management
- Financial reports and analytics
- Multi-channel notifications (SMS, WhatsApp, Email)
- Audit trail and activity logs

### Member Portal
- Independent login
- Personal dashboard with contribution and loan summary
- M-Pesa STK Push payments
- Loan applications
- Welfare assistance requests
- Transaction history
- Notifications

### Language
- Full Kiswahili translation across both portals
- Per-account language, so one reader's choice does not affect anyone else
- Admin-set group default for anyone who has not chosen
- Configurable currency, symbol, position and separators, applied everywhere

### Payment Integration
- M-Pesa STK Push (in-app payments)
- M-Pesa C2B (Paybill/Till number)
- Cash and bank transfer recording

### Notifications
- SMS via Africa's Talking or Twilio
- WhatsApp via Twilio
- Email via Nodemailer
- In-app notifications

## Technology Stack

- **Frontend:** React 18, Vite, React Router, Recharts, Lucide Icons
- **Backend:** Node.js, Express
- **Database:** MySQL (XAMPP)
- **Authentication:** JWT + bcrypt
- **Payment:** Safaricom Daraja API

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 20.x or 22.x LTS | Runs the API |
| MySQL | 8.0+ | Or MariaDB 10.6+ |
| XAMPP | Any recent | Local development only |
| Nginx | 1.18+ | Production serving |
| Ubuntu Server | 22.04 or 24.04 LTS | Production target |

> **Deploying to a server?** Follow **[DEPLOYMENT.md](DEPLOYMENT.md)** — it covers requirements,
> Nginx, SSL, M-Pesa, backups and troubleshooting.

### Local Setup (XAMPP)

### 1. Database Setup

1. Open XAMPP Control Panel
2. Start **Apache** and **MySQL**
3. Open phpMyAdmin (http://localhost/phpmyadmin)
4. Create a new database called `the_team_chama`
5. Import the schema file: `database/schema.sql`

### 2. Backend Setup

1. Navigate to the backend folder:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure environment variables in `.env`:
   ```env
   DB_HOST=localhost
   DB_USER=root
   DB_PASSWORD=
   DB_NAME=the_team_chama
   JWT_SECRET=your_secret_key_here
   PORT=5000
   ```

4. Start the backend server:
   ```bash
   npm run dev
   ```

### 3. Frontend Setup

1. Navigate to the frontend folder:
   ```bash
   cd frontend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the app:
   ```bash
   npm run dev       # for working on it
   npm run install   # to use it (builds, then serves on one port)
   ```

4. Open it in your browser:

   | Command | Address | Notes |
   |---|---|---|
   | `npm run dev` | http://localhost:3000/admin | Hot reloading. Cannot be installed as an app. |
   | `npm run install` | http://localhost:5000/admin | Built and served by the backend, one port, installable. |

   The two portals are separate paths: `/admin` for administrators and
   `/member` for members. Signing in takes you to the right one.

   To lose the port entirely and have a real address such as
   `https://yourchama.co.ke/admin`, see **[DEPLOYMENT.md](DEPLOYMENT.md)**.
   It is one config file, and nothing in the app changes.

### 4. M-Pesa Configuration

Register at [Safaricom Daraja](https://developer.safaricom.co.ke/) and create a sandbox app for
your Consumer Key and Secret.

Credentials can be entered in **Settings → M-Pesa Configuration**, which is the recommended
route: they take effect immediately, with no server restart and no file editing. `.env` is
supported as a fallback:

```env
MPESA_CONSUMER_KEY=your_consumer_key
MPESA_CONSUMER_SECRET=your_consumer_secret
MPESA_SHORTCODE=174379
MPESA_PASSKEY=your_passkey
MPESA_CALLBACK_URL=http://localhost:5000/api/mpesa/callback
```

### M-Pesa Status panel

The Settings card shows what the API is **actually using**, per field, and re-checks after every
save:

| Badge | Meaning |
|-------|---------|
| **saved here** | The value from this screen is in use |
| **from .env** | Saved but ignored — the API is falling back to the environment file |
| **unset** | Neither place has a usable value |

Secrets are never echoed back; the consumer key is masked (`GQVN***du`).

Resolution order is: the value saved in Settings when usable, then `MPESA_*` from the
environment. A value is treated as **absent** when it is empty or still looks like a placeholder
(`your_…`, `xxx`, `change_me`) — the sample `.env` ships with
`MPESA_CONSUMER_KEY=your_consumer_key_here`, and sending that to Safaricom produces an opaque
rejection. Instead, a fresh install honestly reports *"M-Pesa is not configured"* and names what
is missing.

> This panel exists because of a bug worth remembering. Saving the card wrote the values to the
> database, but the Daraja calls read `process.env` exclusively. **The save worked and changed
> nothing at all**, which from the Settings screen is indistinguishable from a broken save. The
> panel turns that class of silent no-op into something you can see.

`POST /api/mpesa/stk-push` and `POST /api/mpesa/register-c2b` now refuse with a clear message when
credentials are incomplete, rather than sending a doomed request:

> *"M-Pesa is not configured. Add the consumer key, consumer secret, shortcode and STK passkey in
> Settings, or set MPESA_* in the environment."*

### Environment: sandbox or live

**Settings → Payments → M-Pesa Configuration** has a two-way switch, *Sandbox* or
*Live (production)*, above the credentials. It decides which Safaricom system every
payment prompt reaches:

| | Sandbox | Live (production) |
|---|---|---|
| Daraja host | `sandbox.safaricom.co.ke` | `api.safaricom.co.ke` |
| Money | Simulated. No real payments. | Real. Members are charged. |

The status panel shows the resolved host in full, so "production" is never just a
label you chose and forgot. An unrecognised value resolves to **sandbox**, never to
live: guessing wrong that way costs a failed test, not a member's money.

Resolution order is `mpesa_environment` in Settings, then `MPESA_ENV` in the
environment. Migration `013_mpesa_environment.sql` seeds the row as `sandbox`, which
matches what an install with `MPESA_ENV` unset was already doing.

> This used to be settable only by editing `MPESA_ENV` on the server and restarting.
> It was the only M-Pesa decision an operator makes repeatedly that the app could
> not make, since going live is the point of the exercise.

**Live refuses to send while the callback URL is a placeholder.** STK Push, test
prompt and paybill registration all return `400` naming `mpesa_callback_url`,
because Safaricom could take a real payment and the confirmation would have nowhere
to arrive. In sandbox the same guard does not apply — nothing real is at stake, and
the only way to find out whether STK Push works is to send one.

That guard was initially missing from `test-prompt` while present on `stk-push`, so
the test button could reach the live endpoint with no way to confirm. Found by
switching to production and pressing it. Both now refuse, before any network call.

### When STK Push fails: the Daraja URLs

**`404.001.03 "Invalid Access Token"` on STK Push is the most common M-Pesa problem, and it is not
a bug in this app.**

Getting an OAuth token works fine — the credentials are valid — and the *next* call is refused.
That happens because the STK Push endpoint has not been registered against your consumer key in the
Daraja portal. A consumer key on its own is not enough.

Fix it once, at [developer.safaricom.co.ke](https://developer.safaricom.co.ke/):

1. Open your app → **URLs**
2. Under **Initiate Customer M-PESA Transaction**, add:

   | Environment | URL to add |
   |-------------|-----------|
   | Sandbox | `https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest` |
   | Live | `https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest` |

3. For C2B, also add a **Confimation and Validation URL** pair pointing at your
   `/api/mpesa/confirmation` and `/api/mpesa/validation`

The consumer key, shortcode, passkey and callback URL must all belong to **the same app**. Copying a
passkey from a different app is another common cause (`400.002.31`).

### Callback URL: sandbox vs production

The callback is where Safaricom posts payment confirmations. Two rules, because they differ:

| Environment | Placeholder callback |
|-------------|----------------------|
| **sandbox** | Allowed. The prompt is sent and a checkout ID is returned; confirmations do not arrive, so the transaction stays `pending` here. Fine for testing. |
| **production** | **Refused**, because a payment would succeed and the receipt would vanish. |

> This used to be refused in both, which was a mistake worth naming. The only way to find out
> whether STK Push works at all is to send one — and the guard blocked the send before anything
> reached Safaricom, so you were stuck without a next step.

When the sandbox warning applies it is returned in the response as `warning` and shown as a toast,
rather than being swallowed into a transaction stuck on `pending`.

The callback can now be set in **Settings → M-Pesa** like every other M-Pesa field, and takes
effect immediately — no editing a file on the server, no restart. It falls back to
`MPESA_CALLBACK_URL` from the environment when left blank, and the Settings status panel shows which
of the two is in use.

Safaricom cannot reach `localhost`. To receive real confirmations on your own machine you need a
public tunnel in front of port 5000 (ngrok, Cloudflare Tunnel, or similar) and must put that public
address here **and** register it as the Confirmation URL in the Daraja portal.

### Errors are reported honestly

A Daraja rejection is a **configuration** problem on Safaricom's side, not a server fault, so it is
returned as `502` with Daraja's own code and message rather than a generic `500`:

```json
{
  "error": "Safaricom rejected the request: Invalid Access Token",
  "daraja_code": "404.001.03",
  "daraja_message": "Invalid Access Token",
  "hint": "Daraja refused the request. Open your app at developer.safaricom.co.ke, go to \"URLs\" and add https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest under \"Initiate Customer M-PESA Transaction\"..."
}
```

The Contributions screen shows the code and the hint as toasts, rather than a bare "failed".

Codes with a known fix are translated: `404.001.03`, `400.002.03`, `400.002.06`, `400.002.31`,
`400.002.26`, `400.002.32`, `400.003.03`, `400.002.24`, `400.001.07`. Anything unmapped still
returns Daraja's own message, so a new code is never swallowed.

Two things are also checked **before** Safaricom is contacted, to fail fast with a clear reason:

- **Credentials incomplete** → *"M-Pesa is not configured. Add the consumer key, consumer secret,
  shortcode and STK passkey…"*
- **Callback URL missing or still the sample value** → refused with the reason, because a
  placeholder callback means payments would succeed and the receipts would vanish. Safaricom
  cannot reach `localhost`.

### One honest gap

Selecting **M-Pesa** in the member **Pay Loan** dialog records a payment but does **not** raise an
STK prompt. `POST /api/loans/:id/pay` writes the repayment directly, so that path is a
self-declared payment with no Safaricom confirmation.

STK Push is currently wired only to the Contributions screen. Wiring it to member loan repayment
means initiating the push, then recording the payment from the *callback* rather than the click —
otherwise a member could mark a loan paid and cancel the prompt. That is a separate piece of work.

### 5. Seed the Database

Create the super admin account and demo data (see next section):

```bash
cd backend
node seed.js
```

## Creating Accounts & Test Data

After the database is imported, run the seed script to create the super admin and demo data:

```bash
cd backend
node seed.js
```

The script is safe to re-run — it uses upserts, so you can run it any time to reset passwords.

### Login Credentials

The seed script creates every administrator account on **one password that you
supply**. There is no default. A password written into a script is a password
that works on every install the script has ever been run against, and this
repository is public - so publishing one would publish a working login.

```bash
cd backend
ADMIN_PASSWORD='choose-something-long' node seed.js
```

```powershell
# PowerShell
cd backend
$env:ADMIN_PASSWORD = 'choose-something-long'; node seed.js
```

Leave `ADMIN_PASSWORD` unset and the script generates a strong one and prints it
once, on the line that says so. It is not written to disk: save it at the moment
it appears, or run the seed again with `ADMIN_PASSWORD` set.

**Admin portal** (login with username or email):

| Role | Username | Email |
|------|----------|-------|
| Super Admin | `admin` | `admin@theteam.com` |
| Treasurer | `treasurer` | `treasurer@theteam.com` |
| Chairperson | `chair` | `chair@theteam.com` |
| Secretary | `secretary` | `secretary@theteam.com` |

All four are created on that same password. Change the ones you intend to keep,
from Settings, once you are in.

### Checking a deployment

The suites under `backend-php/` sign in as the super admin, so they need the
same password. They read it from `ADMIN_PASSWORD` in `backend/.env`, which is in
`.gitignore` and never published:

```
ADMIN_PASSWORD=choose-something-long
```

**Member portal** (login with phone):

| Member | Phone | Password |
|--------|-------|----------|
| Mary Wanjiku | `0711000001` | `member123` |
| John Otieno | `0711000002` | `member123` |

> The members above are demo rows and `member123` belongs to them alone. Every
> other password in the project is either generated for you or set by hand.

### Super Admin: Portal Switching (no password required)

The super admin can open the system as any member or admin **without entering their
password or username**. This is useful for checking what a member actually sees, or
reproducing another admin's view.

**How to use it**

1. Log in as super admin
2. Click **Portal Switch** in the sidebar (only visible to super admin)
3. Pick a member or admin and click *Open Member Portal* / *Open Admin Portal*
4. An orange banner stays on screen for the whole session
5. Click **Exit & return to Super Admin** — no password needed to go back

**Safety measures built in**

| Protection | How it works |
|------------|--------------|
| Super admin only | `requireSuperAdmin` middleware, not just a permission flag |
| Other admins blocked | Non-super-admins get `403` on both endpoints |
| Members blocked | Member tokens get `403` |
| Fully audited | Every switch is written to `audit_logs` with your name and the target |
| Visible session | Persistent banner prevents acting on the wrong account |
| Kill switch | Set `allow_impersonation` to `0` in Settings to disable it entirely |

No member password or credential is ever exposed — the server issues its own short-lived
token for the target session.

To turn it off, set `allow_impersonation` to `0`:

```sql
UPDATE settings SET setting_value = '0' WHERE setting_key = 'allow_impersonation';
```

> Note: an impersonated session keeps full permissions of the account it is viewing, so
> loan approvals, welfare approvals and deletions still work. Check the banner before
> confirming anything irreversible.

### Verifying Role-Based Access

Log in as different roles to confirm the menus differ:

| Role | Sees |
|------|------|
| Super Admin | Everything (full menu, 13 permissions) |
| Treasurer | Members, Contributions, Loans, Reports (5 permissions) |
| Chairperson | Members, Contributions, Loans, Welfare, Reports, Notifications (7 permissions) |
| Secretary | Members, Notifications only (2 permissions) |

## Project Structure

```
the-team/
├── backend/
│   ├── config/
│   │   └── database.js
│   ├── controllers/
│   │   ├── adminController.js
│   │   ├── authController.js
│   │   ├── contributionController.js
│   │   ├── loanController.js
│   │   ├── memberController.js
│   │   ├── mpesaController.js
│   │   ├── notificationController.js
│   │   ├── reportController.js
│   │   ├── settingsController.js
│   │   └── welfareController.js
│   ├── middleware/
│   │   └── auth.js
│   ├── routes/
│   │   ├── admins.js
│   │   ├── auth.js
│   │   ├── contributions.js
│   │   ├── loans.js
│   │   ├── members.js
│   │   ├── mpesa.js
│   │   ├── notifications.js
│   │   ├── reports.js
│   │   ├── settings.js
│   │   └── welfare.js
│   ├── .env
│   ├── package.json
│   └── server.js
├── database/
│   └── schema.sql
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   └── Sidebar.jsx
│   │   ├── context/
│   │   │   └── AuthContext.jsx
│   │   ├── pages/
│   │   │   ├── AdminDashboard.jsx
│   │   │   ├── AdminManagement.jsx
│   │   │   ├── Contributions.jsx
│   │   │   ├── Loans.jsx
│   │   │   ├── Login.jsx
│   │   │   ├── MemberDashboard.jsx
│   │   │   ├── Members.jsx
│   │   │   ├── Notifications.jsx
│   │   │   ├── Reports.jsx
│   │   │   ├── Settings.jsx
│   │   │   └── Welfare.jsx
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── main.jsx
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
└── README.md
```

## Member Self-Registration

Members can apply to join from the login page, and an admin approves before they get access.

**Lifecycle**

```
Register (public)  ->  pending  ->  approve  ->  active  ->  can log in
                                  ->  decline  ->  rejected (reason stored)
```

A `pending` member cannot log in. The login response tells them why:

| Status | Login response |
|---|---|
| `pending` | "Your registration is still waiting for admin approval." |
| `rejected` | "Your registration was not approved. Please contact the chama office." |

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/auth/register` | **Public.** Create a pending registration |
| `GET /api/members/registrations` | Pending list, plus counts and recent declines |
| `POST /api/members/registrations/:id/approve` | Approve (sets `active`) |
| `POST /api/members/registrations/:id/reject` | Decline, with a required reason |

All three admin endpoints need `manage_members`. The Secretary cannot see or action
registrations; the Chairperson and Super Admin can.

### Abuse protection

`POST /api/auth/register` is unauthenticated, so it has its own budget:
`REGISTER_RATE_LIMIT_MAX` (default **5 per hour per IP**). It also rejects duplicate phone
numbers and emails, and distinguishes "you already applied and are waiting" from "you were
declined" so people aren't left guessing.

### Deliberate asymmetry

Admins adding a member directly via `POST /api/members` creates them as **`active`**
immediately — that person is vouching for them. Only self-service sign-ups go through review.
Note the `members.status` column default is `pending`, so `createMember` sets the status
explicitly to avoid new admins being created as pending.

### Settings

One **Save** button per card, each writing every field on that card in **one transaction**:

| Card | Fields saved together |
|------|----------------------|
| General Settings | chama name, monthly contribution, **loan interest rate**, loan duration, max loan multiplier, welfare contribution |
| Language, Currency & Number Format | language, currency, symbol, symbol position, both separators |
| M-Pesa Configuration | paybill, shortcode, consumer key, consumer secret, passkey |
| Email Configuration | sender address, SMS API key |

Save is **disabled until something changes**, and the hint names what is pending — *"Unsaved: Loan
interest rate, Loan duration"* — so a click either saves or is visibly unavailable.

> This used to be broken in a way that looked fine. Each card had a button that wrote a single
> hardcoded key: "Save General Settings" persisted only the chama name, and the format card
> rendered **six identical Save buttons**, one per hidden key. The loan interest rate could not be
> saved through the UI at all — typing 17.5 and clicking Save left 10 in the database. A partially
> applied save is worse than a failed one, because the operator cannot tell which half stuck.

`PUT /api/settings` takes `{ values: { key: value } }`. It validates every key **before** writing
any, so a bad value leaves nothing applied, and it refuses keys outside an allowlist:

- `install_id` cannot be reset from the UI — that would break the link between a support report and
  an installation
- `allow_impersonation` is a deliberate security toggle, not a side effect of saving a card
- Numeric ranges are enforced server-side: interest 0–100%, duration 1–60 months

The single-key route `PUT /api/settings/:key` still exists and now reports honestly. It used to
return success even when it matched no row, which is how a field could look saved and never persist.

## Appearance (Skins & Themes)

**Settings → Appearance** changes the look of the whole system. Six skins:

| Skin | Look |
|------|------|
| Emerald | Green (default) |
| Ocean | Blue |
| Sunset | Orange into pink |
| Forest | Teal into lime |
| Plum | Purple into pink |
| Slate | Neutral grey, formal |

Plus **Light** / **Dark** mode. Choosing a skin recolours the sidebar, buttons, stat cards,
cash-book hero, focus rings and charts, because those gradients reference CSS variables
rather than fixed hex values.

### How it is applied

`ThemeProvider` writes `data-theme` and `data-mode` onto `<html>`, and the stylesheet keys
off those attributes. Each skin only redefines `--brand`, `--accent` and the sidebar gradient —
**neutrals are untouched**, so contrast ratios are guaranteed whichever skin is chosen.

Dark mode overrides only the neutral tokens, so every skin keeps its identity in the dark
variant. Tinted panels (welfare notices, impersonation banner, previews) get darker bases in
dark mode so they do not glare.

### Shared look vs personal

Two levels, deliberately separate:

| Action | Who it affects |
|---|---|
| Click a skin or mode | **This browser only**, remembered in `localStorage` |
| **Save for everyone** | Writes `theme` / `color_mode` to settings as the default for all |
| **Use shared look** | Clears the local override, snapping back to the group default |

So one admin can work in dark mode without changing the look for everybody. A local override
always wins over the shared setting, which also prevents the shared theme flashing before the
browser's own preference is applied.

Sharing requires `system_settings`.

## Account Menu in the Header

The signed-in account moved out of the sidebar footer to the **top-right of the header**,
which is present on every screen. It was cramped in the collapsed icon rail and unreachable on
small screens.

The chip shows initials, name and role. Clicking opens a dropdown with the full name, contact
detail, current role, and a **Log out** action. It closes on outside click or `Escape`.

On phones the name collapses to just the avatar so the header stays usable.

## Language, Currency & Number Format

Under **Settings → Language, Currency & Number Format** you control how every amount in the
system is written.

| Setting | Options |
|---|---|
| Your language | Follow the group default, English, Kiswahili |
| Group default language | English, Kiswahili |
| Currency | KES, TZS, UGX, USD, EUR, GBP, ZAR, RWF |
| Currency Symbol | Any text, e.g. `KSh`, `$`, `€` |
| Symbol Position | Before (`KSh 1,250`) or After (`1,250 KSh`) |
| Decimal Separator | Dot (`1,250.50`) or Comma (`1.250,50`) |
| Thousands Separator | Comma, Dot, Space, or None |

Picking a currency pre-fills the matching symbol (`KES → KSh`, `UGX → USh`, `USD → $`).
A live preview shows four amounts plus a percentage so the combination is obvious before
you save.

### The interface is actually translated

Kiswahili is a full translation, not a stub. Every screen in both portals renders in
whichever language applies to the reader.

Language is resolved most-specific-first:

1. **The account's own preference.** Set from the header picker or
   **Settings → Your language**, saved per account in `members.language` / `admins.language`.
2. **`localStorage`.** A cache only, so the right language paints before the network
   answers. The saved account preference overrides it once it arrives.
3. **The group default** in Settings, the `language` setting.
4. **English.**

This means one member reading in Kiswahili does not force it on anyone else. `NULL` in the
database means "no opinion, follow the group", which is why the column is nullable and why
clearing it is valid rather than an error.

The header picker applies instantly and needs no save. The group default is an ordinary
setting and uses the card's Save button like every other card.

### Adding or changing a translation

| Where | What goes there |
|---|---|
| `frontend/src/i18n/dictionaries.js` | Shared vocabulary. English is the source of truth and the fallback for any missing key |
| `frontend/src/i18n/parts/*.js` | Area-specific strings, split so parts of the app can be translated independently |
| `frontend/src/i18n/I18nContext.jsx` | `useI18n()` giving `t()`, `lang`, `setLanguage` |

In a component:

```jsx
const { t } = useI18n();
<h1>{t('nav.loans')}</h1>
<button title={t('common.close')} />
t('loans.of', { n: 1, total: 9 })
```

A key missing from Kiswahili falls back to English rather than showing a raw key, and
`npm run audit:i18n` reports the gaps:

```
missing-en         t('some.key') has no English text at all
untranslated       t('some.key') has English but no Kiswahili
placeholder-mismatch  en uses {n} but sw uses {total}
orphan-key         a sw key with no English counterpart
```

It also lists keys that are identical in both languages, since a value that was meant to be
translated but was copied across is otherwise invisible.

### Number formatting is applied everywhere

Formatting is not confined to the Settings screen. `FormatContext` loads the public settings
and every page uses it, so changing the currency updates the dashboard, cash book, reports,
member portal, tables and chart tooltips at once.

It is done by hand rather than `toLocaleString` because browsers disagree about space
separators and about where a currency symbol belongs, and a printed statement needs to match
the books exactly. Percentages are handled separately so they never pick up a currency symbol.
Dates do use `toLocaleDateString`, but with a locale pinned per language (`en-GB`, `sw-KE`)
rather than taken from the device, so two members of the same chama see identical printed
dates.

### Terminology is fixed deliberately

These words are printed in the same room as the books, so the Swahili is chosen for accuracy
rather than word-for-word equivalence:

| English | Kiswahili | Note |
|---|---|---|
| member | **wanachama** | never *wanafunzi*, which means learners |
| contribution | **mchango / michango** | |
| balance | **salio** | |
| loan | **mkopo / mikopo** | |
| welfare fund | **hazina ya wafaahamu** | |
| outstanding | **bado iliyolipwa** | |
| dashboard | **dashibodi** | |
| decimal separator | **nukta** | East African usage |
| cash | **fedha tasifu** | to distinguish it from a digital method |

The footer attribution is never translated — the names stay literal in every language,
because that credit has to remain readable regardless of the reader's choice.

### Two things worth knowing

**The footer credit and the `LICENSE` terms are deliberately left in English**, as is
`M-Pesa`, `Safaricom`, `STK Push` and all currency codes. Only interface wording is
translated.

**`thousand_separator` uses `none` as a sentinel** in the database, because an empty string
cannot be told apart from a space separator.

## Roles & Rights (super admin only)

The super admin controls what every role may do, at two levels.

**Roles & Rights** in the sidebar (super admin only) holds:

### Permission matrix

Rows are the 13 permissions, grouped into categories (Members, Contributions, Loans, Welfare,
Reports, Communication, Administration). Columns are roles. Tick a box to grant, untick to
remove — saved immediately, effective on that admin's next request.

### Custom roles

Create your own role with any permission set, rename it, or delete it. Names must be
lowercase with underscores (`auditor`, `vice_treasurer`).

### Custom rights per admin

**Custom rights** beside an admin lets you single one person out: grant something extra, or
take something away, without inventing a whole role. Each permission has three states:

| State | Meaning |
|---|---|
| from role | Inherited from their role |
| granted extra | Explicitly added for this admin |
| removed | Explicitly denied for this admin |

Overrides live in `admin_permission_overrides` and are applied by the auth middleware on every
request: role permissions first, then `grant` adds, then `revoke` removes.

### Lockouts that cannot happen

| Guardrail | Why |
|---|---|
| Super admin column is locked | Otherwise nobody could restore permissions, locking the system permanently |
| Super admin overrides rejected | Same reason |
| Built-in roles cannot be deleted | Chairperson/secretary/etc. are referenced by seed and docs |
| Built-in roles cannot be renamed | Keeps code and docs honest about what exists |
| A role cannot be emptied | Nobody using it would be able to do anything at all |
| Role in use cannot be deleted | Admins must be reassigned first |
| Unknown permission names rejected | Catches typos instead of silently granting nothing |

All role/permission changes are written to `audit_logs`.

**Endpoints**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/roles` | Roles, permissions, admin counts |
| `POST /api/roles` | Create a custom role |
| `PUT /api/roles/:id` | Rename a custom role |
| `PUT /api/roles/:id/permissions` | Replace a role's permissions |
| `DELETE /api/roles/:id` | Delete an unused custom role |
| `GET /api/admin-permissions/:adminId` | One admin's effective rights + overrides |
| `PUT /api/admin-permissions/:adminId` | Save overrides |

These routes require `requireSuperAdmin`, deliberately stricter than `manage_admins`:
handing out rights is a different job from creating admin accounts.

## Navigation

Both portals use the same collapsible sidebar.

### Menu groups

The sidebar is split into labelled groups, and **each group can be hidden or shown** by
clicking its heading (the chevron rotates when collapsed).

| Admin portal | Member portal |
|---|---|
| Overview · Members · Finance · Welfare · Communication · Administration | Overview · My Money · Support |

Groups the current role can't use are dropped entirely, so a Secretary never sees an empty
"Finance" heading. Which groups are hidden is remembered in `localStorage`.

### Collapse to icon rail

The chevron button in the sidebar header collapses the sidebar to a **76px icon rail**:
labels disappear, icons centre, and icons gain `title` tooltips so they stay identifiable.
The content area shifts to match. The preference is saved, so the layout looks the same next
time you open the system.

### Layout modes

| Width | Behaviour |
|-------|-----------|
| `≥ 1025px` | Full sidebar, collapse toggle available |
| `≤ 1024px` | Drawer: full-width sidebar behind a topbar hamburger |

The breakpoint lives in one place (`DESKTOP_QUERY` in `Layout.jsx`) and mirrors the
`max-width: 1024px` query in `index.css`. Rail mode is ignored on small screens — there is no
room for it, and the drawer is always full width.

### Access note

This is a **display preference only**, stored per browser in `localStorage`. It hides links
from view but grants nothing: every route is still enforced by `authenticate` and
`authorize` on the server. A member who hand-edits `localStorage` still gets `403`.

## Notification Templates

Every message the system sends is editable in **Settings → Notification Templates**, with a
placeholder reference beside each editor, a live preview, and a test button.

| Template key | Sent when |
|---|---|
| `tpl_account_created` | An admin approves a registration |
| `tpl_welcome` | After approval, welcoming the member |
| `tpl_due_7days` | 7 days before a loan is due |
| `tpl_due_3days` | 3 days before a loan is due |
| `tpl_due_1day` | 1 day before a loan is due |
| `tpl_loan_due` | On the due date itself |

Templates are plain text in the `settings` table, so wording can be changed without a
deployment.

### Placeholders

Bodies may contain `{{token}}` markers. **17 are supported**, listed in the UI and clickable to
insert:

`{{member_name}}` `{{chama_name}}` `{{phone}}` `{{email}}` `{{monthly_contribution}}`
`{{reminder_day}}` `{{paybill}}` `{{loan_amount}}` `{{balance}}` `{{amount_due}}`
`{{total_repayable}}` `{{interest}}` `{{interest_rate}}` `{{due_date}}` `{{days_left}}`
`{{application_date}}` `{{loan_status}}`

The list lives in `backend/utils/templates.js` and is served to the UI from the same place, so
a placeholder can never be advertised but unsupported. Unrecognised tokens are reported in the
preview instead of being silently sent.

### Preview vs send

| Endpoint | Behaviour |
|----------|-----------|
| `POST /api/notifications/templates/test` with `dry_run: true` | Renders only, sends nothing |
| same with `dry_run: false` | Renders and attempts delivery |
| `GET /api/notifications/templates` | Template metadata + placeholder list |

Preview is the default so you can check wording before any provider exists. A real send reports
`sent` / `skipped (not configured)` / `failed` separately — it never claims success it did not
achieve. The **In-app** channel always succeeds, which makes it useful for verifying flow
before SMS credentials are set up.

Editing requires `send_notifications`, so the Secretary and Chairperson can maintain wording.

### Loan due reminders still need a trigger

The templates define the wording, but **nothing yet fires them on schedule**. Sending on the
1-day / 3-day / 7-day marks requires a daily job that looks for loans approaching their
`due_date` and queues the matching template per member. That scheduler is not built — today
the templates are edited and tested manually, and the only automatic sender is
`POST /api/notifications/remind` for members behind on contributions.

## Admin Dashboard

Rebuilt around the four questions a chair or treasurer actually asks, in this order:

| Question | Widget |
|----------|--------|
| Can we pay people? | **Cash In Bank** tile |
| Who owes us? | **Owed By Members** tile |
| Are we growing? | **Member Savings** tile + **Savings Growth** chart |
| Are we earning? | **Money Position** card with net profit strip |
| What's on me? | **Needs Attention** tile + **Waiting On You** card |

Then **Quick Moves** for common tasks.

### What was cut

| Removed | Why |
|---|---|
| Duplicate "Contributions Trend" chart | Same data as the growth chart |
| "Loan Recovery" donut | Already a stat in the growth panel |
| 10 of the 14 stat cards | Duplicated each other; crowded out the decisions |
| Verbose profit breakdown + note | Replaced by a three-figure profit strip |

Result: **14 stat cards / 8 sections / 6.3 screens → 4 / 4 / 3.1 screens**, one chart.

`GrowthPanel.jsx`, `RemindersPanel.jsx` and `BalanceCard.jsx` were deleted once folded in, so
there is no dead code.

### Waiting On You

One card, three rows, each with the action attached:

- **Loan applications** awaiting approval, with the total requested and the oldest date
- **Membership requests** awaiting approval, with the names
- **Members behind on savings**, with the total outstanding, whether any loan is overdue, and
  a one-click **Remind** button

A short table underneath names who is behind and why, capped at five rows.

### Restricted roles

Money tiles are **hidden, not zeroed**. An admin without `view_reports` previously saw
`Cash In Bank: KSh 0`, which reads as "the chama has no money" rather than "you may not see
this". They now get only the tiles they can act on, plus a short note explaining that
financials need report access.

## Loan Interest Rule

Chama interest is **flat and inclusive**. It is charged once on the borrowed amount and folded
into the total the member repays:

```
interest  = principal × rate ÷ 100
repayable = principal + interest
```

| Borrowed | Rate | Interest | Repays |
|----------|------|----------|--------|
| 1,000 | 10% | 100 | **1,100** |
| 3,000 | 10% | 300 | **3,300** |
| 3,000 | 25% | 750 | **3,750** |

It is **not** a reducing balance and **not** compounded on what is still owed. A 1,000 loan at
10% stays at 1,100 whether it is cleared in one payment or five — never 1,105, 1,110.50 and so
on.

### The rate is locked per loan

The rate is copied onto the loan row **when the member applies**. Raising the default in
Settings later does not reprice a loan already taken. Only an explicit override at approval
changes it.

### Where to set it

| Where | What it does |
|-------|--------------|
| **Settings → Loan Interest Rate** | Default applied to newly submitted applications |
| **Settings → Loan Duration** | Default term, in months |
| **Loans → Approve** | Per-loan override of either, with the arithmetic shown before committing |

The approval dialog shows the borrower's amount, the interest and the exact total repayable,
and recomputes live as the rate is typed:

```
Amount borrowed = KSh 3,000
Interest at 10% = KSh 300
Total repayable = KSh 3,300
```

Leave the duration blank to take the chama default.

### Validation

| Input | Result |
|-------|--------|
| Amount of `0` or negative | Rejected — *"Enter a loan amount greater than zero."* |
| Rate below 0% or above 100% | Rejected — *"Interest rate must be between 0 and 100%."* |
| Duration below 1 or above 60 months | Rejected — *"Loan duration must be between 1 and 60 months."* |
| Approving an already-approved loan | Rejected — *"This loan was already approved."* |

### Interest still outstanding

Repayments are recorded as single amounts with no interest/principal split, so the interest
still owed is derived pro rata from the balance and **labelled an estimate** in the UI:

```
interest_outstanding = balance ÷ total_repayable × interest_amount
```

This keeps the same proportion of interest the loan started with, which is the most honest
figure available without splitting every repayment at the point it is taken.

## Chama Branding

Set the name and logo once in **Settings → General Settings**, and it appears everywhere.

### The name

`chama_name` was already read by the notification and reminder code. It is now also the brand
shown in the interface:

| Where | Shows |
|-------|-------|
| Header | Name beside the logo |
| Sidebar | Name above the portal label |
| Sign-in screen | Page heading |
| Registration | "Join &lt;name&gt;" |
| Browser tab | "&lt;name&gt; - Chama Management" |
| Footer | "© &lt;year&gt; &lt;name&gt;" |

It falls back to **THE TEAM** when unset or blank, so no screen can render an empty brand. The
value comes from the existing `/api/settings/public` response — no new endpoint, and no new context
on the frontend.

### The logo

An **Upload logo** control sits at the top of the General Settings card, with a live preview, plus
**Replace** and **Remove**. When no logo is set, the original gradient `TT` mark is drawn instead,
so the app never shows a broken image.

| | |
|---|---|
| Formats | PNG, JPEG, GIF, WebP |
| Maximum | 512KB (a phone photo is rejected with advice to resize) |
| Best size | Square, around 200×200 |
| Permissions | `system_settings` — super admin, or a role granted it |

The image is contained inside a square box rather than stretched, so a wide logo is not distorted.

### How the logo is stored

As **base64 text** in a `chama_profile` table, served from `GET /api/chama/logo`.

Storing bytes in the database rather than a file means a deployment needs **no writable upload
directory and no extra nginx rule**, and the logo survives a rebuild, an rsync or a second app
instance unchanged.

> Base64 is deliberate. `logo_data` is a `MEDIUMTEXT` column, so MySQL and Node both reinterpret
> it through the connection charset. Writing raw binary into it and reading it back without
> decoding silently corrupts every byte above `0x7F` — the first attempt stored a 51,160-byte PNG
> and served back 51,214 bytes of mojibake that no browser would render. Base64 is plain ASCII and
> round-trips exactly.

Uploads arrive as base64 in JSON rather than multipart, which keeps the dependency list unchanged.
Validation reads the **magic bytes**, not the browser-supplied MIME type, so a text file renamed to
`.png` is rejected:

> *"Only PNG, JPEG, GIF and WebP images are accepted."*

`GET /api/chama/logo` is public and cached for a day (`?v=` busts it after an upload), because the
sign-in screen needs it before anyone signs in. When no logo is set the frontend draws the
fallback mark **without requesting it**, so an unset logo produces no 404 on any page.

### One thing to know

The logo endpoint is deliberately unauthenticated — the sign-in page needs it. It serves a logo and
nothing else, so no member data is exposed. If you ever put something private in that table, add
auth to `GET /api/chama/logo` and drop the logo from the sign-in screen.

## Menu Overlap

Overlapping menus come from stacking order and from two overlays being open at once. Both are
pinned down in CSS rather than left to chance.

### Sidebar Logout vs the nav list

The sidebar is a **flex column**, and only the middle of it scrolls:

```
.sidebar         display: flex; flex-direction: column; overflow: hidden
.sidebar-header  flex-shrink: 0
.sidebar-nav     flex: 1 1 auto; min-height: 0; overflow-y: auto   <- the only scroller
.sidebar-foot    flex-shrink: 0                                    <- a real row, not an overlay
```

`.sidebar-foot` used to be `position: absolute; bottom: 0` over a sidebar that scrolled itself,
with a **semi-transparent gradient** background. It was pinned to the viewport bottom while nav
items flowed underneath it, and those items stayed visible through the gradient — so with more
menu than height, the last few links sat on top of **Logout** and the button could not be clicked.
Nothing about that improved as the menu grew; the overlap simply became unavoidable.

`flex: 1 1 auto` plus **`min-height: 0`** on `.sidebar-nav` is the part that matters: without
`min-height: 0` a flex child will not shrink below its content height, so the nav pushes the
footer off the bottom instead of scrolling.

Verified on the desktop layout with every nav group expanded: 13 links, 191px of overflow, and
**no visible link overlapping Logout** — at the top of the scroll and at the bottom. Logout is the
topmost element at its own centre, so it is genuinely clickable.

### Stacking ladder

Declared once in `:root` and used everywhere, so a new layer cannot quietly land in the wrong
place:

| Variable | Value | Layer |
|----------|-------|-------|
| `--z-backdrop` | 65 | Page dimmer behind the mobile drawer |
| `--z-sidebar` | 70 | Drawer / icon rail |
| `--z-header` | 80 | Fixed top bar |
| `--z-toast` | 150 | Transient messages |
| `--z-modal` | 200 | Dialogs |

The account dropdown declares `z-index: 90`, but that value is **scoped inside the header's
stacking context** — the header is `position: fixed` with a z-index, which creates one, and a
child can never escape it. That is deliberate, and it is why the header sits above the sidebar
rather than the dropdown being pushed higher. Raising the dropdown's number would change nothing,
so don't be misled by it.

### Never two menus at once

The drawer and the account menu are both overlays anchored to the same top bar. Opening the
drawer while the account menu was open used to leave the menu floating over the drawer with nothing
indicating which layer was in front. The account menu now closes whenever the drawer opens.

The account menu also closes on:

- navigating to another page (it used to hang over the new page)
- **Escape**
- clicking outside it
- logging out

### Sidebar brand vs the collapse button

The collapse button is `position: absolute` at the sidebar's top right. `.sidebar-header`
reserves `48px` of right padding for it, and the chama name truncates with an ellipsis, so a long
name cannot run underneath. Verified with a 37-character name: an 8px clear gap, no collision.

### Dropdown viewport safety

The account menu has `max-height: calc(100vh - var(--topbar-h) - 20px)` and scrolls internally, so
it cannot be cut off on a short window.

> Rail mode (the collapsed icon sidebar) is desktop-only — `collapsed = isDesktop &&
> preferCollapsed` — so it cannot be exercised below the 1025px breakpoint.

> **Testing note.** These checks were made by measuring `getBoundingClientRect()`. Anything driven
> by a CSS `transition` (the drawer slide-in, the sidebar width) needs the page to be producing
> animation frames to settle. In a headless or backgrounded tab it does not, and the measured value
> stays frozen at the start of the transition — which looks exactly like the animation being broken.
> Set `transition: none` before measuring, or the result is meaningless.

## Member Loan Repayment

A member repays their own loan from the member portal — **My Loans → Pay Loan**. The button appears
on every loan that is `active` or `disbursed` with a balance, and again on the summary hero so it
does not have to be hunted for.

### Full or partial

The dialog opens pre-filled with the full balance, and states the consequence before you commit:

| Entered | Shows |
|---------|-------|
| The whole balance | *"Loan fully repaid — nothing left to pay"* |
| Less than the balance | *"Left to pay after this: KSh 2,500"* |
| More than the balance | *"That is more than the balance. The most you can pay now is KSh 3,500."* — button disabled |

Shortcuts: **Pay in full**, plus round amounts (KSh 100 / 500 / 1,000 / 2,500) that are genuinely
useful on a chama balance. Methods: M-Pesa, STK Push, cash, bank. An optional reference can be
recorded for reconciliation.

`POST /api/loans/:id/pay` takes a **member** token. The loan id is in the path and ownership is
re-checked server-side, so the endpoint cannot be pointed at someone else's loan — it answers the
same `404 Loan not found` whether the loan is missing or simply not yours. An admin token is
rejected outright.

### Two bugs this replaced

The admin-only `recordRepayment` route had no validation at all, and both failures were live:

- A **negative** repayment *increased* the balance — paying −500 on a 3,500 loan left the member
  owing 4,000
- An **overpayment** set `amount_paid` to 101,499 on a 5,500 loan, because the balance was clamped
  to zero while `amount_paid` kept accumulating. That figure feeds the profit report, which sums
  loan totals

Both routes now share one `applyRepayment` that validates, writes inside a transaction, and derives
`amount_paid` instead of incrementing it:

| Input | Result |
|-------|--------|
| Zero, negative, or not a number | *"Repayment must be greater than zero."* |
| More than the balance | *"That is more than the balance. The most you can pay now is 3,000.00."* |
| Loan already `completed` | *"This loan is already fully repaid."* |
| Loan `pending` or `rejected` | Refused — a loan that is not disbursed cannot take payment |
| Someone else's loan | `404` — indistinguishable from a missing one |
| Any rejected attempt | **Nothing is written**; the loan and the repayment row share a transaction |

When a payment clears the balance the loan becomes `completed` and the derived interest estimate
drops to zero, since nothing is outstanding.

## Member Loan Balance & Interest

A member with a loan sees exactly what they owe, split into principal and interest.

### What You Owe panel

| Figure | Meaning |
|---|---|
| Total outstanding | Everything still owed across all open loans |
| Principal still to pay | The borrowed portion |
| **Interest still to pay** | Interest remaining on the loan |
| Repayment progress | Paid vs total, with a bar and percentage |
| Next due date | Nearest due date, turning red and reading *Overdue* if past |

Two stat cards carry the same figures: **Total Outstanding** and **Interest To Pay**.

The applications table gains **Interest** (with its rate) and **Owed Now** (with
"incl. KSh 318.18 int." underneath). The member's Loans page shows the same panel plus an
**Interest left** column.

### How interest still owed is worked out

Flat-interest chama loans charge one interest figure on the principal for the whole term.
Repayments arrive as single amounts with no record of which part cleared interest, so the
remainder is derived pro rata:

```
interest_outstanding = balance / total_repayable * interest_charged
```

Worked example — a KSh 5,000 loan at 10%, total repayable KSh 5,500, with KSh 2,000 paid:

| | |
|---|---|
| Balance | KSh 3,500 |
| of which principal | KSh 3,181.82 |
| of which interest | KSh 318.18 |
| Repaid | 36.36% |

**This is an estimate and is labelled as one in the UI.** To make it exact, repayments would
need to record an interest/principal split. A loan with a settled balance shows zero interest
outstanding.

### Dates

MySQL returns `DATE` columns as JS `Date` objects, so `toISOString()` would shift the day for
anyone east or west of UTC. `loanMath.dateOnly()` formats from local components instead, and
every loan row leaves the API as a plain `YYYY-MM-DD` string. `days_to_due` and `is_overdue`
are computed server-side.

Endpoints carrying the breakdown: `GET /api/members/dashboard` (`loans` + `loan_summary`) and
`GET /api/loans/mine`.

## Member Loan Visibility

A member's portal shows the full loan lifecycle, not just a balance:

- **My Loan Applications** card on the dashboard — every application with amount, purpose,
  total repayable, due date and status
- Member-friendly wording, so `pending` reads as **"Waiting for approval"** rather than
  exposing internal status names
- `/api/loans/mine` returns only the signed-in member's loans and repayments

Previously members pointed at `/api/loans`, which requires `view_loans` and returned **403**,
so the member Loans page rendered empty. The dashboard also called
`/api/welfare/requests`, which members cannot access — producing console 403s on every load.
Both are now single, correctly-scoped calls.

## Cash Book

`GET /api/ledger/cashbook` merges every source of cash into one ledger so the balance is
explainable.

**Money in** — member savings · loan repayments · welfare contributions · other income

**Money out** — operating expenses · loans disbursed · welfare paid out · other spending

### The two distinctions that matter

Collapsing these makes the books wrong, so both are reported separately:

1. **Loans disbursed are not spending.** They leave the bank but become a receivable.
   They sit in "money out" for the cash book, then get added back to give net worth.
2. **Member savings and welfare funds are held on trust.** They are a liability, never profit.

The cash book is cash-basis, so it will differ from the accrual figures in
`/api/reports/growth` (interest *charged* vs interest *collected*). Both views are
intentional — treasurers need both.

### Worked example from the demo data

| | KES |
|---|---|
| Money in: savings 18,000 + repayments 10,800 + other 350 | 29,150 |
| Money out: loans 23,000 + expenses 1,450 + other 850 | 25,300 |
| **Current balance** | **3,850** |
| Plus receivable from members | 14,500 |
| **Net worth** | **18,350** |
| Held for members (liability) | 18,000 |
| Real spending (excluding loans lent) | 2,300 |

### Manual entries

Money with no other home — interest collected in cash, donations, fines, stationery bought
directly — goes in `ledger_entries`:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/ledger/cashbook` | Full cash book with itemised ledger |
| `POST /api/ledger` | Record money in or out (with description) |
| `DELETE /api/ledger/:id` | Remove an entry; balance recalculates |

## Financial Widgets

The admin dashboard answers three questions a treasurer is always asked:
*are we growing, how much interest are we earning, and are we actually making money?*

### Chama growth
Total savings, average per member, month-on-month growth rate, loan recovery rate, plus a
combined chart of monthly contributions against the cumulative savings curve (12 months).

### Interest and profit

| Figure | Meaning |
|--------|---------|
| Interest earned | Chama **income** — interest charged on disbursed loans |
| Interest payable | **Liability** — interest owed to members on savings when they exit |
| Running expenses | Stationery, transport, bank fees, meeting costs |
| Net profit | Interest earned − expenses − loan write-offs |
| Net interest position | Interest earned − interest payable to members |

Savings contributions are **member money held on trust**, so they are deliberately excluded
from income and reported as growth only. Counting them as income is the most common mistake
in chama reporting, and it inflates profit by the entire savings balance.

Interest payable uses the `savings_interest_rate` setting (default 5%).

### Reminders

`GET /api/reports/reminders` finds members who need chasing:

| Reason | Severity | Trigger |
|--------|----------|---------|
| `not_paid` | medium | No contribution this month |
| `missed_contributions` | high | Two or more months missed |
| `overdue_loan` | high / critical | Balance outstanding past `due_date` |
| `defaulted_loan` | critical | Loan written off as defaulted |

Members who joined less than a month ago are skipped so newcomers are not chased
immediately. Detection lives in `backend/utils/riskMembers.js` and is shared by both the
dashboard widget and the reminder sender, so the two can never disagree.

`POST /api/notifications/remind` sends the reminders:

```json
{
  "member_ids": [4, 5],
  "channels": ["sms", "whatsapp"]
}
```

Omit `member_ids` to remind everyone currently flagged as behind.

**Channel honesty** — each channel is attempted independently and reports what actually
happened. If a provider is not configured you get `skipped`, not a fake `sent`:

```json
{ "sent": 0, "skipped": 6, "failed": 0, "results": [
  { "member": "David Mwangi", "channel": "sms", "status": "failed",
    "skipped": true, "detail": "No SMS provider configured" }
]}
```

Placeholder values in `.env` (anything starting with `your`, containing `xxx`, etc.) are
treated as unconfigured, so the app never fires real API calls with template credentials.

### Expenses

Profit needs expenses, so they are tracked in the `expenses` table:

| Endpoint | Purpose |
|----------|---------|
| `GET /api/reports/expenses` | List with totals and per-category breakdown |
| `POST /api/reports/expenses` | Record an expense |
| `DELETE /api/reports/expenses/:id` | Remove an expense |

## Installing on a Phone (PWA)

The app installs to the home screen and runs full screen, with no browser bars.

**Opening it on a phone offers the install automatically.** Once installed it never asks
again.

### How the request works

| Step | What happens |
|---|---|
| Page opens on a phone | The install sheet appears |
| **Install app** | The browser's own install dialog opens |
| Installed | Nothing is ever shown again on that device |
| **Not now** | Not shown again for 30 days, then it may offer once more |

Two independent signals enforce "never again", so a missed browser event still cannot
produce a second request:

1. The `appinstalled` event, recorded to `localStorage`
2. Detecting the page is already running standalone

Both are checked on every load. The check lives in
`frontend/src/components/InstallPrompt.jsx`.

**Why a sheet rather than the browser's own bar:** Chrome's built-in mini-infobar is easy
to miss and cannot be styled or translated. Suppressing it with `preventDefault()` and
presenting our own means the message is in the reader's own language.

### iPhone and iPad

Safari does not allow a site to install itself, and fires no install event. There the
sheet explains the three taps instead — it cannot pretend otherwise.

To detect a future browser capability, check for `getInstalledRelatedApps` or the
`beforeinstallprompt` event before writing more platform branches.

### Checking it works before deploying

Append `?install=1` to any URL to force the sheet on any device, including a desktop
browser. It only shows the sheet; it cannot install anything by itself. If the button
stays disabled, that browser has not offered a prompt — open the same URL on a phone.

`Settings → About` carries the same controls permanently: **I have installed it** for
anyone who installed from the browser menu instead of the sheet, and **Ask me again** to
clear a dismissal.

### What is cached, and what is deliberately not

The service worker caches the app shell and the hashed build assets so the app opens
instantly and works offline. **It never caches anything under `/api/`.**

That is deliberate. This is a savings group app: a stale contribution total or loan
balance is worse than no offline support, because it looks authoritative and invites a
decision based on numbers that are no longer true. API traffic is always network-first
with no cache fallback, so a request fails honestly when the network is down.

| Path | Strategy |
|---|---|
| `/api/*` | Network only. Never read from or written to cache |
| Navigations | Network first, cached shell as the offline fallback |
| Static assets | Cache first, revalidated in the background |

### Files

| File | Purpose |
|---|---|
| `frontend/public/manifest.webmanifest` | Name, icons, colours, display mode, shortcuts |
| `frontend/public/sw.js` | The service worker |
| `frontend/src/pwa.js` | Registration, install-state helpers |
| `frontend/src/components/InstallPrompt.jsx` | The sheet |
| `frontend/scripts/generate-icons.mjs` | Regenerates the icons |

### Icons

`npm run icons` regenerates the icon set. They are generated rather than committed
binaries so the mark stays editable and any size can be produced, using only Node's
`zlib` with no image dependency.

Produced: 192 and 512 (`any`), 512 (`maskable`), 180 (Apple), 64 (favicon). The maskable
variant keeps the glyph inside the safe circle, because Android crops the outer fifth to
the launcher's shape.

The mark is the emerald brand colour, matching the default skin. If you change the brand
colour, change `BRAND` in the generator and re-run it. Note that the icons are static,
while the **chama name and logo uploaded in Settings are not** — the manifest and icons
are built into the bundle, so a per-chama name would need the manifest generated at
deploy time. Only the browser chrome (`theme-color`) follows the saved skin at runtime.

### Deployment requirements

**HTTPS is required.** Service workers do not run over plain HTTP, apart from
`localhost`. An install prompt will simply never appear on an http:// domain.

**Serve from the domain root.** The service worker is registered at `/` with scope `/`.
A sub-path deployment such as `example.com/chama/` needs `base: '/chama/'` in
`vite.config.js` and a matching scope in `frontend/src/pwa.js`, plus the absolute paths
in `index.html` and the manifest.

**Bump `VERSION` in `sw.js` when the shell changes.** The cache names are derived from
it; leaving it alone keeps serving a stale shell after a deploy.

Not registered in development (`npm run dev`), because a caching worker fights Vite's
module loading. Use `npm run preview` to test the real thing.

## Design System

The UI is built on a small token-based design system in `src/index.css`.

**Colour palette** — brand green (`--brand`) plus nine accents (blue, orange, purple,
teal, pink, indigo, amber, red, cyan). Every stat card, icon chip and quick action picks a
tone, so each section is visually distinct without hard-coding colours in components.

```jsx
<StatCard icon={Users} label="Active Members" value={42} tone="blue" />
<StatCard icon={Wallet} label="Outstanding" value="KES 12,000" tone="orange" />
```

**Responsive behaviour**

| Breakpoint | Layout |
|------------|--------|
| `> 1024px` | Fixed 264px sidebar, multi-column grids |
| `≤ 1024px` | Sidebar becomes a slide-in drawer with a topbar hamburger |
| `≤ 640px` | Single-column cards, stacked page actions, full-width buttons |
| `≤ 400px` | Stat cards go full width |

Tables scroll horizontally instead of breaking the layout, modals go edge-to-edge on
phones, and `prefers-reduced-motion` disables animations for users who need it.

**Frontend**

| File | Purpose |
|------|---------|
| `pages/AdminDashboard.jsx` | Cash position, savings growth, waiting-on-you |
| `pages/CashBook.jsx` | Money in/out, position and itemised ledger |
| `pages/Registrations.jsx` | Approve or decline pending members |
| `pages/RolesPermissions.jsx` | Permission matrix, custom roles, per-admin rights |
| `components/Header.jsx` | Top bar with the account menu |
| `components/Sidebar.jsx` | Role-aware navigation |
| `components/Layout.jsx` | Header, drawer/rail state, media query, persistence |
| `components/ImpersonationBanner.jsx` | Persistent impersonation warning |
| `components/StatCard.jsx` | Gradient metric card, plus `QuickAction` |
| `context/FormatContext.jsx` | Currency/separator-aware money, number, percent, date |
| `context/ThemeContext.jsx` | Skin and light/dark mode, shared vs local |

**Backend**

| File | Purpose |
|------|---------|
| `config/env.js` | Chooses `.env` or `.env.production`, validates production secrets |
| `config/database.js` | MySQL pool |
| `ecosystem.config.js` | PM2 process definition; sets `NODE_ENV=production` |
| `server.js` | Middleware order, rate limiters, route mounting |
| `middleware/auth.js` | Typed-token verification and effective permissions |
| `utils/loanMath.js` | Loan interest/principal split, repayment %, due dates |
| `utils/riskMembers.js` | Shared behind-detection for widget and reminder sender |
| `utils/notifier.js` | SMS/WhatsApp/email dispatch |
| `utils/templates.js` | Templates, placeholders, render and unknown-token detection |

## License

**Non-Commercial MIT License** — full text in [`LICENSE`](LICENSE).

> Developed by **Kenneth Ndugi** under **WILNCOM TECH**.

This is *based on* the MIT License with one change: **commercial use is not permitted**.
Because of that it is **not** the standard MIT License — if you need real MIT, you don't have
it, and calling it "MIT" in a contract would be inaccurate.

| You may | You may not |
|---------|-------------|
| Use it free of charge | Sell it, or any part of it |
| Run it for your own chama or cooperative | Charge anyone for it |
| Adapt it to your own needs | Use it in a paid or commercial product |
| Share it with other savings groups | Use it as part of a service you charge for |
| Study it and suggest improvements | Remove the copyright or footer attribution |

The footer attribution — *"Developed by Kenneth Ndugi under WILNCOM TECH"* — must stay visible
in any adapted version, including the footer of a modified copy. That is what keeps your name
attached to work derived from this.

Third-party dependencies remain under their own licences and are unaffected.

> This is a plain-English licence written for this project, not legal advice. If you plan to
> enforce it or licence commercially, have a lawyer review it.

### Branding

Every page carries a footer with the developer credit and the licence summary, including the
login and registration screens:

```
Developed by Kenneth Ndugi under WILNCOM TECH
© 2026 THE TEAM · Free to use and adapt for your own group · Not for resale
```

Rendered by `components/Footer.jsx` — from the app shell for signed-in pages, and from `App.jsx`
for the login screen. Colours are verified against WCAG AA (4.5:1) in both light and dark mode
over the login gradient.

## Tracking Copies & Responding to Misuse

### The honest starting point

**Once someone has the source, you cannot track it.** They can delete any line of it. What you
can do is make a copy *identifiable* and make misuse *noticeable*. Those are different things and
this section is about the second.

If you publish the source publicly, a licence check is pointless — anyone can fork, remove it and
carry on. The protections that do work are attribution, copyright, and evidence you can gather
after the fact.

### What this build gives you

| Field | Where | Why |
|-------|-------|-----|
| `version` | `GET /api/health`, `GET /api/settings/about` | Ties a bug report to a release |
| `build` | same | Distinguishes two deploys of the same version |
| `install_id` | Settings → About & Licence | Stable per-server UUID, generated on first boot |
| Footer attribution | every page | Makes an unmodified copy recognisable in the wild |

Stamp the commit at deploy time, otherwise two builds on the same day look identical:

```bash
BUILD_ID=$(git rev-parse --short HEAD) pm2 restart theteam-api --update-env
```

`GET /api/health` stays **unauthenticated** and returns version and build only — no install id and
no member data, so a monitoring probe cannot read anything sensitive. The install id is behind
`system_settings`.

### How to actually find copies

| Method | What it gives you |
|--------|-------------------|
| **Publish on GitHub/GitLab** | Forks appear in the network graph, with names attached. Free and automatic. |
| **GitHub Code Search** | Search a distinctive string from your source across all of GitHub |
| **grep.app** | Same idea, indexes more of the long tail |
| **Sampled sightings** | A bug report from a stranger's server is evidence a copy exists |
| **Support requests** | Ask for the install id; a blank or mismatched answer tells you something |

The footer attribution is what creates the trace. If someone strips it, they have taken themselves
out of reach — which is itself information.

### When you find misuse

1. **Preserve evidence first** — repo URL, commit hashes, screenshots with dates, the URL it was
   found at. Screenshots of a public page are the weakest form; a dated, archived copy is stronger.
2. **Confirm what the licence actually says** and that the copy kept no attribution. If the
   attribution is intact, the situation is a licence-breach argument, not plagiarism.
3. **Register your copyright first** if you have not. In Kenya, copyright arises automatically on
   fixation, but registration fixes the date you can prove — which is often the whole dispute.
4. **Then** decide: a written request to fix or remove, a takedown, or a commercial licence.

### What you cannot do

- Detect a copy that was never published anywhere you can see
- Force a fork to remove your name — the licence requires attribution, but only a court can
  enforce it
- Stop someone who has already read the code

Anyone promising airtight protection for distributed source is selling something. This approach
raises their effort, produces evidence, and keeps your name on compliant copies.

> This is a technical view, not legal advice. Have a lawyer review the licence and any response
> before sending anything to a third party.

## Production Deployment

Full guide: **[DEPLOYMENT.md](DEPLOYMENT.md)**

### Architecture

```
Member or Admin browser
        │  HTTPS (443)
        ▼
┌───────────────────────────┐
│  Nginx                    │  serves the built React app
│  · TLS from Let's Encrypt │  proxies /api → 127.0.0.1:5000
│  · SPA fallback           │  MySQL never exposed
└───────────┬───────────────┘
            │ localhost
            ▼
┌───────────────────────────┐
│  Node.js / Express (PM2)  │  restarts on crash and on reboot
└───────────┬───────────────┘
            │ localhost
            ▼
┌───────────────────────────┐
│  MySQL (127.0.0.1 only)   │
└───────────────────────────┘
```

Only ports **22, 80 and 443** are open. The API (5000) and database (3306) stay on loopback.

### Quick reference

| Step | Command |
|------|---------|
| Install | `sudo apt install -y nginx mysql-server nodejs` |
| Database | `sudo mysql < database/schema.sql` |
| Migrations | `for f in database/migrations/*.sql; do sudo mysql the_team_chama < "$f"; done` |
| API deps | `cd backend && npm ci --omit=dev` |
| Seed | `cd backend && NODE_ENV=production node seed.js` |
| Frontend build | `cd frontend && npm ci && npm run build` |
| Run API | `pm2 start ecosystem.config.js && pm2 save && pm2 startup` |
| SSL | `sudo certbot --nginx -d chama.example.com` |

### Two settings that must change in production

```env
JWT_SECRET=<openssl rand -hex 48>
```

Set in `backend/.env.production` — and set `NODE_ENV=production` in
`backend/ecosystem.config.js`, **not** inside the env file. The app must know it is in
production before it can decide which file to read.

`backend/config/env.js` handles that choice, then validates the essentials and names any
missing variable on startup:

```
[env] Loaded .env.production, .env (NODE_ENV=production)
[env] FATAL in production — missing: DB_PASSWORD. Put them in backend/.env.production.
```

Read the first lines of `pm2 logs theteam-api` after the first boot.

### The Nginx line people miss

```nginx
try_files $uri $uri/ /index.html;
```

React Router uses history URLs, so without this, **refreshing `/cashbook` returns 404** even
though clicking through the app works.

### M-Pesa needs a public HTTPS callback

Safaricom cannot reach `localhost`. STK Push only works once `MPESA_CALLBACK_URL` is a real,
publicly reachable HTTPS URL ending in `/api/mpesa/callback`. Test it with `curl` from any
machine before assuming it works.

## Environment Variables

`backend/.env` (local) and `backend/.env.production` (server):

| Variable | Purpose | Production value |
|---|---|---|
| `NODE_ENV` | `development` or `production` | `production` — set in `ecosystem.config.js`, **not** in an env file |
| `PORT` | API port | `5000` |
| `DB_HOST` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | MySQL connection | `127.0.0.1` + dedicated user |
| `JWT_SECRET` | Token signing key | **random, never the sample** |
| `JWT_EXPIRES_IN` | Token lifetime | `12h` |
| `FRONTEND_ORIGIN` | Extra CORS origin if API is on a separate domain | omit when Nginx proxies `/api` |
| `RATE_LIMIT_MAX` | General API limit per 15 min | `300` |
| `LOGIN_RATE_LIMIT_MAX` | Login attempts per 15 min | `10` |
| `REGISTER_RATE_LIMIT_MAX` | Public registrations per hour | `3` |
| `MPESA_ENV` | `sandbox` or `production` | `production`. Overridden by `mpesa_environment` in Settings. |
| `MPESA_CONSUMER_KEY` / `MPESA_CONSUMER_SECRET` | Daraja credentials | from Safaricom |
| `MPESA_SHORTCODE` / `MPESA_PASSKEY` | PayBill/Till | from Daraja |
| `MPESA_CALLBACK_URL` | Public HTTPS callback | `https://your-domain/api/mpesa/callback` |
| `SMS_USERNAME` / `SMS_API_KEY` | Africa's Talking | for SMS |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Twilio | for SMS/WhatsApp |
| `EMAIL_HOST` / `EMAIL_USER` / `EMAIL_PASS` | SMTP | for email |

`backend/config/env.js` reads `.env.production` when `NODE_ENV=production` and `.env`
otherwise, with the other file filling any gaps. Values still looking like placeholders
(`your_...`, containing `xxx`) are treated as **not configured**, so the app reports `skipped`
instead of firing failed API calls.

## API Endpoints

### Authentication
- `POST /api/auth/register` - Public member self-registration (creates pending member)
- `POST /api/auth/admin-login` - Admin login
- `POST /api/auth/member-login` - Member login
- `GET /api/auth/profile` - Get current user profile
- `PUT /api/auth/change-password` - Change password

### Members
- `GET /api/members` - Get all members
- `GET /api/members/registrations` - Pending self-registrations awaiting approval
- `POST /api/members/registrations/:id/approve` - Approve a registration
- `POST /api/members/registrations/:id/reject` - Decline a registration (reason required)
- `GET /api/members/:id` - Get single member
- `POST /api/members` - Create member
- `PUT /api/members/:id` - Update member
- `DELETE /api/members/:id` - Delete member
- `GET /api/members/dashboard` - Member dashboard data

### Contributions
- `GET /api/contributions` - Get all contributions
- `POST /api/contributions` - Record contribution
- `GET /api/contributions/summary` - Contribution summary
- `GET /api/contributions/member/:id` - Member contributions

### Loans
- `GET /api/loans` - Get all loans
- `POST /api/loans/apply` - Apply for loan
- `POST /api/loans/:id/approve` - Approve loan
- `POST /api/loans/:id/disburse` - Disburse loan
- `POST /api/loans/repayment` - Record repayment
- `GET /api/loans/pending` - Get pending loans

### M-Pesa
- `POST /api/mpesa/stk-push` - Initiate STK Push (`record_contributions`)
- `POST /api/mpesa/test-prompt` - Send one prompt and record nothing (`system_settings`)
- `POST /api/mpesa/callback` - STK result posted by Safaricom
- `POST /api/mpesa/validation` - C2B validation posted by Safaricom
- `POST /api/mpesa/confirmation` - C2B confirmation posted by Safaricom
- `POST /api/mpesa/register-c2b` - Register the paybill URLs (`system_settings`)
- `GET /api/mpesa/status` - Credentials in use, environment, resolved base URL

The three Safaricom-posted routes are unauthenticated by necessity: Safaricom sends
no credentials of ours. They are identified instead by the transaction ID they
quote. `validation` and `confirmation` were **missing** until now while
`register-c2b` already pointed at them, so registering the paybill published two
URLs that answered 404 and every C2B payment would have been lost. Both now answer
`Accept`, always — a non-zero code makes Safaricom treat a payment that genuinely
succeeded as failed and retry it.

`test-prompt` runs the identical Daraja call as `stk-push` but records nothing, so
the Daraja setup can be verified without recording a contribution against a member.
Without it, the only way to learn whether STK Push was wired up at all was to take
someone's money.

### Reports
- `GET /api/reports/financial-summary` - Financial summary
- `GET /api/reports/growth` - Growth, interest and profit figures
- `GET /api/reports/reminders` - Members who have not paid or are behind
- `GET /api/reports/expenses` - Expenses with totals and category breakdown
- `POST /api/reports/expenses` - Record an expense

### Cash Book
- `GET /api/ledger/cashbook` - Money in, money out, balance and itemised ledger
- `POST /api/ledger` - Record a manual money in/out entry
- `DELETE /api/ledger/:id` - Delete a manual entry

### Roles & Rights (super admin only)
- `GET /api/roles` - Roles, permissions and admin counts
- `POST /api/roles` - Create a custom role
- `PUT /api/roles/:id/permissions` - Replace a role's permissions
- `DELETE /api/roles/:id` - Delete an unused custom role
- `GET /api/admin-permissions/:adminId` - One admin's effective rights
- `PUT /api/admin-permissions/:adminId` - Save per-admin overrides

### Reminders
- `GET /api/reports/reminders` - Members who have not paid or are behind
- `POST /api/notifications/remind` - Send SMS/WhatsApp/email reminders
- `GET /api/notifications/templates` - Template metadata + placeholder list
- `POST /api/notifications/templates/test` - Preview or send a test message

### Loans
- `GET /api/loans/mine` - The signed-in member's own loans and repayments
- `GET /api/reports/monthly` - Monthly report
- `GET /api/reports/member/:id` - Member statement

### Members
- `GET /api/members` - Members with savings, loan balance and whether they can be deleted
- `DELETE /api/members/:id` - Delete, refused with `409` when financial history exists
- `PATCH /api/members/:id/status` - Set `active` / `inactive` / `suspended`

Deleting a member is refused when they have contributions, loans, repayments, welfare
records, ledger entries or audit logs. The response names what is in the way and sets
`can_deactivate`, because cascading a delete through those tables would rewrite the savings
ledger and could erase money still owed. `GET /api/members` reports `can_delete` and
`history_blockers` per member so the UI can explain before an admin clicks.

### Payment Gateways
- `GET /api/payment-gateways` - Registry, enabled state and the flat method list (either portal)
- `PUT /api/payment-gateways/:key` - Switch a gateway on or off (`system_settings`)

One row per gateway, one method each:

| `gateway_key` | Stored `payment_method` | Collects money? |
| --- | --- | --- |
| `mpesa_stk` | `mpesa_stk` | Yes, via Daraja STK Push |
| `mpesa_c2b` | `mpesa_c2b` | Yes, via Daraja callback to the paybill |
| `airtel_money` | `airtel_money` | **No.** Listed and selectable, integration not built |
| `bank` | `bank` | Recorded by hand |
| `cash` | `cash` | Recorded by hand |

M-Pesa is split into two entries because its products are chosen separately: STK Push needs the
Daraja STK endpoint registered on your app, the paybill needs a public callback URL. Both read
the same `mpesa_*` credentials; only the registered endpoint differs, and each gateway reports
the one it needs in Settings.

Credentials stay in `settings` under `mpesa_*` and `airtel_*`. This is the catalogue. Switching a
gateway off removes it from every payment form in both portals; historical rows keep the method
they were written with. The last enabled gateway cannot be switched off, and if the table is
edited by hand until nothing is enabled, Cash is still offered so a payment can be recorded.

A gateway that is enabled but not wired is withheld from `enabled_methods` and reported as
`suppressed_unwired`, so a member is never offered a payment the app cannot confirm. Settings
says so explicitly rather than letting the switch look broken.

Migration `012_payment_gateways_split.sql` performs the split, inherits whatever enabled state
the old combined `mpesa` row had, and adds `airtel_money` to the `payment_method` enum in all
five tables that carry it.

### Language (per account)
- `GET /api/me/language` - The signed-in account's override, or `null`
- `PUT /api/me/language` - Save `{ language }`, or `null` to follow the group default

Accepts either an admin or a member token; the table is chosen from the token type, never
from the request body. Codes are validated against the list with real translations
(`en`, `sw`) and again by a `CHECK` constraint.

## Built By

**Kenneth Ndugi — WILNCOM TECH.** Released under the Non-Commercial MIT License: free to use and
adapt for your own group, not for resale. Full terms in [`LICENSE`](LICENSE).
