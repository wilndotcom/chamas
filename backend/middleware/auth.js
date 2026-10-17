const jwt = require('jsonwebtoken');
const pool = require('../config/database');

/**
 * Role permissions plus any per-admin overrides.
 *
 * grant adds a permission the role lacks, revoke removes one it has. The super
 * admin is never filtered so the system cannot be locked out of its own repair
 * controls.
 */
const effectivePermissions = async (adminId, roleName, rolePermissions) => {
  let effective = rolePermissions.map((p) => p.name);

  if (roleName === 'super_admin') return effective;

  try {
    const [overrides] = await pool.execute(
      `SELECT p.name, o.mode
       FROM admin_permission_overrides o
       JOIN permissions p ON p.id = o.permission_id
       WHERE o.admin_id = ?`,
      [adminId]
    );

    overrides.forEach((o) => {
      if (o.mode === 'grant') {
        if (!effective.includes(o.name)) effective.push(o.name);
      } else {
        effective = effective.filter((n) => n !== o.name);
      }
    });
  } catch (error) {
    // Overrides are an enhancement; failing to read them must not lock an
    // admin out of the permissions their role already grants.
    console.error('Failed to load permission overrides:', error.message);
  }

  return effective;
};

/**
 * The few routes an administrator may still reach before replacing the password
 * their account was created with.
 *
 * Administrator accounts start on one shared password that is written into this
 * published repository, so that signing in for the first time needs no generated
 * string read off a screen. That is only safe while it lasts: until the password
 * is replaced the account is not really a credential, it is a door left open.
 *
 * Without an opening the account could never escape the state, and a mandatory
 * password change that also blocks the password change is a locked door with the
 * key on the wrong side. So: its own profile (read on every page load), the
 * change itself, the language preference, and the name and logo the change screen
 * is drawn with. None of these exposes anything about the group's money.
 *
 * Matched against the end of the path rather than compared whole, because the
 * same app is served from the root of a domain and from a folder such as
 * /the-team. A whole-path comparison would stop matching on a prefixed install,
 * and the first thing it would block is the profile request the app makes on
 * every load - bouncing an administrator who had just signed in correctly back
 * to the login screen.
 */
const PASSWORD_CHANGE_EXEMPT = [
  '/api/auth/profile',
  '/api/auth/change-password',
  '/api/auth/refresh',
  '/api/me/language',
  '/api/settings/public',
  '/api/chama/profile'
];

const passwordChangeExempt = (req) => {
  const path = (req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');
  return PASSWORD_CHANGE_EXEMPT.some((route) => path.endsWith(route));
};

/**
 * Answers a flagged administrator with the same refusal the PHP backend gives.
 *
 * Returns true when the request has been answered, so the caller can simply
 * `if (refuseUntilPasswordChanged(req, res, admin)) return;` and cannot forget to
 * stop. Both places that authenticate an admin call this, because a rule enforced
 * at one of two doors is a rule with a way around it.
 */
const refuseUntilPasswordChanged = (req, res, admin) => {
  if (!admin || !admin.must_change_password) return false;
  if (passwordChangeExempt(req)) return false;

  res.status(403).json({
    error: 'Your password must be changed before you can continue.',
    must_change_password: true
  });
  return true;
};

/**
 * Verifies a JWT and loads the principal.
 * Tokens are typed: 'admin' or 'member'. A token of the wrong type is rejected,
 * so an admin token can never be used against member-only endpoints (or vice versa).
 */
const verifyToken = async (req, res, next, expectedType) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.type !== expectedType) {
      return res.status(403).json({ error: `This endpoint requires a ${expectedType} token.` });
    }

    // Present when this session was opened via super admin impersonation.
    const impersonated = decoded.impersonated_by ? true : false;

    if (expectedType === 'admin') {
      const [admins] = await pool.execute(
        `SELECT a.id, a.full_name, a.email, a.phone, a.role_id, a.is_active,
                a.must_change_password, r.name as role_name
         FROM admins a
         JOIN roles r ON a.role_id = r.id
         WHERE a.id = ?`,
        [decoded.id]
      );

      if (admins.length === 0) {
        return res.status(401).json({ error: 'Invalid token.' });
      }

      const admin = admins[0];
      if (!admin.is_active) {
        return res.status(403).json({ error: 'Account is deactivated.' });
      }

      if (refuseUntilPasswordChanged(req, res, admin)) return;

      const [permissions] = await pool.execute(
        `SELECT p.name FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = ?`,
        [admin.role_id]
      );

      req.user = {
        id: admin.id,
        type: 'admin',
        full_name: admin.full_name,
        email: admin.email,
        phone: admin.phone,
        role_id: admin.role_id,
        role: admin.role_name,
        impersonated,
        must_change_password: !!admin.must_change_password,
        permissions: await effectivePermissions(admin.id, admin.role_name, permissions)
      };
    } else {
      const [members] = await pool.execute(
        'SELECT id, full_name, email, phone, status FROM members WHERE id = ?',
        [decoded.id]
      );

      if (members.length === 0) {
        return res.status(401).json({ error: 'Invalid token.' });
      }

      const member = members[0];
      if (member.status !== 'active') {
        return res.status(403).json({ error: 'Account is not active.' });
      }

      req.user = {
        id: member.id,
        type: 'member',
        full_name: member.full_name,
        email: member.email,
        phone: member.phone,
        status: member.status,
        impersonated
      };
    }

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid token.' });
    }
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired.' });
    }
    return res.status(500).json({ error: 'Authentication failed.' });
  }
};

const authenticate = (req, res, next) => verifyToken(req, res, next, 'admin');
const authenticateMember = (req, res, next) => verifyToken(req, res, next, 'member');

const authorize = (requiredPermissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }

    // Super admin bypasses all checks
    if (req.user.role === 'super_admin') {
      return next();
    }

    const hasPermission = requiredPermissions.some(
      perm => req.user.permissions.includes(perm)
    );

    if (!hasPermission) {
      return res.status(403).json({
        error: 'Access denied. Insufficient permissions.',
        required: requiredPermissions,
        your_permissions: req.user.permissions
      });
    }

    next();
  };
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.user || req.user.type !== 'admin' || req.user.role !== 'super_admin') {
    return res.status(403).json({
      error: 'Only the super admin can perform this action.'
    });
  }
  next();
};

/**
 * Accepts either an admin or a member token.
 *
 * For endpoints both portals legitimately need, such as the payment gateway
 * list: the member payment forms have to offer exactly the methods the admin has
 * switched on. The token type is placed on req.user.type either way, and these
 * endpoints never return admin-only data, so requiring one specific type would
 * only push the frontend toward a hardcoded list.
 */
const authenticateEither = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    if (decoded.type !== 'admin' && decoded.type !== 'member') {
      return res.status(403).json({ error: 'This endpoint requires a member token.' });
    }

    /*
     * An admin token gets its role and permissions attached, so `req.user` means
     * the same thing here as it does under `authenticate`.
     *
     * Previously this middleware handed back the bare JWT payload, which for an
     * admin token has no `permissions` at all. Any endpoint reachable by both
     * portals therefore could not check an admin's rights without a second
     * query, and a handler that assumed `req.user.permissions` existed would read
     * it as "no permissions" and quietly deny a treasurer access they legitimately
     * had. Strictly additive: no new rejection is introduced, and the existing
     * callers that only read the gateway list are unaffected.
     */
    if (decoded.type === 'admin') {
      const [admins] = await pool.execute(
        `SELECT a.id, a.role_id, a.is_active, a.must_change_password, r.name AS role_name
           FROM admins a
           JOIN roles r ON a.role_id = r.id
          WHERE a.id = ?`,
        [decoded.id]
      );

      // An unknown admin id is left to fail on its own resource rather than here:
      // this middleware is deliberately permissive about identity and only
      // adds context.
      if (admins.length > 0) {
        const admin = admins[0];

        // The first-password rule applies here too. These dual-portal endpoints
        // include the ones an admin uses to record money on somebody's behalf, so
        // leaving this door open would hand back most of what the other guard
        // just closed.
        if (refuseUntilPasswordChanged(req, res, admin)) return;

        const [perms] = await pool.execute(
          `SELECT p.name FROM permissions p
             JOIN role_permissions rp ON p.id = rp.permission_id
            WHERE rp.role_id = ?`,
          [admin.role_id]
        );
        const names = perms.map((p) => p.name);

        req.user = {
          ...decoded,
          role: admin.role_name,
          role_id: admin.role_id,
          is_active: admin.is_active,
          must_change_password: !!admin.must_change_password,
          permissions: await effectivePermissions(admin.id, admin.role_name, names)
        };
        return next();
      }
    }

    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Access denied. Invalid or expired token.' });
  }
};

module.exports = {
  authenticate,
  authenticateMember,
  authenticateEither,
  authorize,
  requireSuperAdmin,
  effectivePermissions
};