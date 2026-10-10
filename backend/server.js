// Must come first: picks .env or .env.production based on NODE_ENV so that
// modules loaded below see the right values.
require('./config/env');

const { APP_VERSION, BUILD_ID } = require('./config/version');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const adminRoutes = require('./routes/admins');
const memberRoutes = require('./routes/members');
const contributionRoutes = require('./routes/contributions');
const loanRoutes = require('./routes/loans');
const welfareRoutes = require('./routes/welfare');
const transparencyRoutes = require('./routes/transparency');
const notificationRoutes = require('./routes/notifications');
const settingsRoutes = require('./routes/settings');
const mpesaRoutes = require('./routes/mpesa');
const reportRoutes = require('./routes/reports');
const ledgerRoutes = require('./routes/ledger');
const roleRoutes = require('./routes/roles');
const adminPermissionRoutes = require('./routes/adminPermissions');
const chamaRoutes = require('./routes/chama');
const paymentGatewayRoutes = require('./routes/paymentGateways');
const meRoutes = require('./routes/me');

const app = express();

// Security middleware
app.use(helmet());
// In production Nginx serves the built frontend and proxies /api, so CORS is
// not strictly needed. FRONTEND_ORIGIN is still honoured so a split-domain
// setup (api.example.com + app.example.com) works.
const allowedOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin:
      process.env.NODE_ENV === 'production'
        ? allowedOrigins.length
          ? allowedOrigins
          : false // same-origin only
        : ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true
  })
);

// Rate limiting.
// The global limit is generous in development so normal use never trips it,
// while login endpoints keep a tight limit where brute force actually matters.
const limiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  max: Number(process.env.RATE_LIMIT_MAX || (process.env.NODE_ENV === 'production' ? 300 : 5000)),
  message: { error: 'Too many requests, please try again shortly.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 20),
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' }
});

// Registration is public and unauthenticated, so it gets its own tighter budget.
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.REGISTER_RATE_LIMIT_MAX || 5),
  message: { error: 'Too many registration attempts. Please try again later.' }
});

app.use('/api/', limiter);
app.use('/api/auth/admin-login', loginLimiter);
app.use('/api/auth/member-login', loginLimiter);
app.use('/api/auth/register', registerLimiter);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging
app.use(morgan('dev'));

// Routes
app.use('/api/auth', authRoutes);
  app.use('/api/account', accountRoutes);
app.use('/api/admins', adminRoutes);
app.use('/api/members', memberRoutes);
app.use('/api/contributions', contributionRoutes);
app.use('/api/loans', loanRoutes);
app.use('/api/welfare', welfareRoutes);
app.use('/api/transparency', transparencyRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/mpesa', mpesaRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/ledger', ledgerRoutes);
app.use('/api/roles', roleRoutes);
app.use('/api/admin-permissions', adminPermissionRoutes);
app.use('/api/chama', chamaRoutes);
app.use('/api/payment-gateways', paymentGatewayRoutes);
app.use('/api/me', meRoutes);

// Health check
// Reports the version and build so a bug report or support request can be tied
// to a specific build. No member data and no install identity is exposed here,
// because this endpoint is unauthenticated.
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'THE TEAM API is running',
    version: APP_VERSION,
    build: BUILD_ID,
    timestamp: new Date()
  });
});

/*
 * ---------------------------------------------------------------------------
 * The app itself
 * ---------------------------------------------------------------------------
 * Serving the built frontend from here is what lets the whole thing run on one
 * port with no proxy to configure: /admin and /member are ordinary paths on the
 * same origin as the API, so there is no port in any URL a member ever sees,
 * and nothing to get wrong when this is hosted.
 *
 * Only when a build exists. During `npm run dev` the frontend is served by Vite
 * and this block is skipped, so there is no chance of the API quietly serving an
 * old build over the top of the live one.
 */
const path = require('path');
const fs = require('fs');

const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');

if (fs.existsSync(path.join(frontendDist, 'index.html'))) {
  /*
   * Hashed asset filenames mean a cache hit is always the right version, so these
   * can be cached hard. index.html is explicitly excluded below.
   */
  app.use(
    express.static(frontendDist, {
      index: false,
      maxAge: '365d',
      immutable: true,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
        // The service worker has to be re-fetched to take effect, so it is held
        // to the same rule as index.html. A cached worker keeps serving an old
        // shell that references assets which no longer exist.
        if (filePath.endsWith('sw.js')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      }
    })
  );

  /*
   * The SPA fallback.
   *
   * Without this, reloading /admin/settings - or opening a link pasted into a
   * WhatsApp group - returns 404, because the server genuinely has no such file.
   * Any path that is not a real file is answered with the shell and the client
   * router sorts it out.
   *
   * /api is excluded, and this is the part that matters: an unknown API route has
   * to keep answering 404 in JSON. Falling through to index.html would hand a
   * caller an HTML page where it expected an error, and a frontend fetch would
   * try to parse it.
   */
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path === '/api') {
      return next();
    }
    res.sendFile(path.join(frontendDist, 'index.html'));
  });

  console.log(`[server] serving the built app from ${frontendDist}`);
} else {
  console.log(
    '[server] no frontend build found - serving the API only. ' +
      'Run `npm run build` in frontend/ to serve the app from this port.'
  );
}

// Error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`THE TEAM API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
