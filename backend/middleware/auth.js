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
        `SELECT a.id, a.full_name, a.email, a.phone, a.role_id, a.is_active, r.name as role_name
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