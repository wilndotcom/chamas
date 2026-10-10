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
