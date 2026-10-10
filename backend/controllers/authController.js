const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

// Admin login
const adminLogin = async (req, res) => {
  try {
    // Accepted as either the admin's username or their email address.
    const { identifier, email, username, password } = req.body;
    const login = [identifier, email, username].find(
      (v) => typeof v === 'string' && v.trim() !== ''
    );

    if (!login || !password) {
      return res.status(400).json({ error: 'Enter your username or email, and your password.' });
    }

    // One lookup covers both. MySQL's default collation is case-insensitive, so
    // "Admin" and "admin" resolve to the same account.
    const [admins] = await pool.execute(
      `SELECT a.*, r.name as role_name FROM admins a
       JOIN roles r ON a.role_id = r.id
       WHERE a.username = ? OR a.email = ?
       LIMIT 1`,
      [login.trim(), login.trim()]
    );

    if (admins.length === 0) {
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    const admin = admins[0];

    if (!admin.is_active) {
      return res.status(403).json({ error: 'Account is deactivated. Contact super admin.' });
    }

    const validPassword = await bcrypt.compare(password, admin.password_hash);
    if (!validPassword) {
      // Deliberately the same wording as an unknown account, so the form does
      // not reveal which usernames exist.
      return res.status(401).json({ error: 'Invalid username/email or password.' });
    }

    // Update last login
    await pool.execute(
      'UPDATE admins SET last_login = NOW() WHERE id = ?',
      [admin.id]
    );

    // Get permissions for this admin, including any per-admin overrides.
    const { effectivePermissions } = require('../middleware/auth');
    const permissions = await effectivePermissions(
      admin.id,
      admin.role_name,
      await pool.query(
        `SELECT p.name FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = ?`,
        [admin.role_id]
      ).then(([rows]) => rows)
    );

    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role_name, type: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      success: true,
      token,
      admin: {
        id: admin.id,
        // Admins are members too (migration 016). The client needs this to
        // offer the signed-in admin as a recipient when recording a welfare
        // contribution, and to reach their own member portal.
        member_id: admin.member_id,
        type: 'admin',
        full_name: admin.full_name,
        email: admin.email,
        phone: admin.phone,
        role: admin.role_name,
        permissions
      }
    });
  } catch (error) {
    console.error('Admin login error:', error);
    res.status(500).json({ error: 'Login failed.' });
  }
};

// Member login
const memberLogin = async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone number and password are required.' });
    }

    const [members] = await pool.execute(
      'SELECT * FROM members WHERE phone = ?',
      [phone]
    );

    if (members.length === 0) {
      return res.status(401).json({ error: 'Invalid phone number or password.' });
    }

    const member = members[0];

    if (member.status !== 'active') {
      if (member.status === 'pending') {
        return res.status(403).json({
          error: 'Your registration is still waiting for admin approval. Please check back later.'
        });
      }
      if (member.status === 'rejected') {
        return res.status(403).json({
          error: 'Your registration was not approved. Please contact the chama office.'
        });
      }
      return res.status(403).json({ error: 'Your account is not active. Please contact the admin.' });
    }

    const validPassword = await bcrypt.compare(password, member.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid phone number or password.' });
    }

    // Update last login
    await pool.execute(
      'UPDATE members SET last_login = NOW() WHERE id = ?',
      [member.id]
    );

    const token = jwt.sign(
      { id: member.id, phone: member.phone, type: 'member' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '24h' }
    );

    res.json({
      success: true,
      token,
      member: {
        id: member.id,
        type: 'member',
        full_name: member.full_name,
        email: member.email,
        phone: member.phone,
        status: member.status
      }
    });
  } catch (error) {
    console.error('Member login error:', error);
    res.status(500).json({ error: 'Login failed.' });
  }
};

// Get current admin profile
const getAdminProfile = async (req, res) => {
  try {
    const [admins] = await pool.execute(
      /*
       * member_id is selected as well as returned below. Selecting it is the part
       * that was missed: the response object referenced a.member_id, which was
       * simply absent from the row, so the field came back undefined and the
       * client treated the signed-in admin as having no member record at all.
       */
      `SELECT a.id, a.member_id, a.full_name, a.email, a.phone, a.role_id, a.last_login,
              a.created_at, r.name as role_name
       FROM admins a JOIN roles r ON a.role_id = r.id WHERE a.id = ?`,
      [req.user.id]
    );

    if (admins.length === 0) {
      return res.status(404).json({ error: 'Admin not found.' });
    }

    const a = admins[0];

    // Resolve overrides so the client never shows a stale menu.
    const { effectivePermissions } = require('../middleware/auth');
    const [rolePerms] = await pool.execute(
      `SELECT p.name FROM permissions p
       JOIN role_permissions rp ON p.id = rp.permission_id
       WHERE rp.role_id = ?`,
      [a.role_id]
    );
    const permissions = a.role_name === 'super_admin'
      ? rolePerms.map((p) => p.name)
      : await effectivePermissions(a.id, a.role_name, rolePerms);

    res.json({
      admin: {
        id: a.id,
        member_id: a.member_id,
        type: 'admin',
        full_name: a.full_name,
        email: a.email,
        phone: a.phone,
        role_id: a.role_id,
        role: a.role_name,
        last_login: a.last_login,
        permissions
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
};

// Change password
const changePassword = async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password are required.' });
    }

    if (new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const [admins] = await pool.execute(
      'SELECT password_hash FROM admins WHERE id = ?',
      [req.user.id]
    );

    const validPassword = await bcrypt.compare(current_password, admins[0].password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const hashedPassword = await bcrypt.hash(new_password, 12);
    await pool.execute(
      'UPDATE admins SET password_hash = ? WHERE id = ?',
      [hashedPassword, req.user.id]
    );

    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to change password.' });
  }
};

/**
 * Portal impersonation.
 *
 * Lets the super admin open the system as a specific member or admin without
 * knowing their password. This is deliberately restricted:
 *   - super admin role only (not merely "has manage_admins")
 *   - can be switched off entirely via the allow_impersonation setting
 *   - every use is written to audit_logs
 *   - the response includes a return token so the session can be ended
 *     without re-entering the super admin password
 */

const impersonationAllowed = async () => {
  const [rows] = await pool.execute(
    "SELECT setting_value FROM settings WHERE setting_key = 'allow_impersonation'"
  );
  return rows.length === 0 || rows[0].setting_value === '1';
};

const logImpersonation = async (adminId, action, details, ip) => {
  await pool.execute(
    'INSERT INTO audit_logs (admin_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
    [adminId, action, JSON.stringify(details), ip || null]
  );
};

const getImpersonationTargets = async (req, res) => {
  try {
    if (!(await impersonationAllowed())) {
      return res.status(403).json({ error: 'Portal impersonation is disabled.' });
    }

    const [members] = await pool.execute(
      "SELECT id, full_name, phone, status FROM members WHERE status = 'active' ORDER BY full_name"
    );

    const [admins] = await pool.execute(
      `SELECT a.id, a.full_name, a.email, a.phone, r.name AS role_name
       FROM admins a JOIN roles r ON a.role_id = r.id
       WHERE a.is_active = TRUE AND a.id <> ?
       ORDER BY a.full_name`,
      [req.user.id]
    );

    res.json({ members, admins });
  } catch (error) {
    console.error('Get impersonation targets error:', error);
    res.status(500).json({ error: 'Failed to load portal targets.' });
  }
};

const impersonate = async (req, res) => {
  try {
    if (!(await impersonationAllowed())) {
      return res.status(403).json({ error: 'Portal impersonation is disabled.' });
    }

    const { target_type: targetType, target_id: targetId } = req.body;

    if (!['member', 'admin'].includes(targetType) || !targetId) {
      return res.status(400).json({ error: 'A valid target_type and target_id are required.' });
    }

    let principal;

    if (targetType === 'member') {
      const [rows] = await pool.execute(
        "SELECT id, full_name, email, phone, status FROM members WHERE id = ? AND status = 'active'",
        [targetId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Member not found or not active.' });
      }
      principal = {
        id: rows[0].id,
        type: 'member',
        full_name: rows[0].full_name,
        email: rows[0].email,
        phone: rows[0].phone,
        status: rows[0].status
      };
    } else {
      const [rows] = await pool.execute(
        `SELECT a.id, a.full_name, a.email, a.phone, a.role_id, r.name AS role_name
         FROM admins a JOIN roles r ON a.role_id = r.id
         WHERE a.id = ? AND a.is_active = TRUE`,
        [targetId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'Admin not found or inactive.' });
      }

      const [permissions] = await pool.execute(
        `SELECT p.name FROM permissions p
         JOIN role_permissions rp ON p.id = rp.permission_id
         WHERE rp.role_id = ?`,
        [rows[0].role_id]
      );

      principal = {
        id: rows[0].id,
        type: 'admin',
        full_name: rows[0].full_name,
        email: rows[0].email,
        phone: rows[0].phone,
        role_id: rows[0].role_id,
        role: rows[0].role_name,
        permissions: permissions.map(p => p.name)
      };
    }

    const expiresIn = process.env.JWT_EXPIRES_IN || '24h';

    const token = jwt.sign(
      { id: principal.id, type: targetType, impersonated_by: req.user.id },
      process.env.JWT_SECRET,
      { expiresIn }
    );

    // Lets the super admin return to their own session without re-authenticating.
    const returnToken = jwt.sign(
      { id: req.user.id, email: req.user.email, role: req.user.role, type: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn }
    );

    await logImpersonation(
      req.user.id,
      'impersonation_login',
      { target_type: targetType, target_id: targetId, target_name: principal.full_name },
      req.ip
    );

    res.json({
      token,
      return_token: returnToken,
      principal: { ...principal, impersonated: true },
      impersonated_by: { id: req.user.id, full_name: req.user.full_name }
    });
  } catch (error) {
    console.error('Impersonation error:', error);
    res.status(500).json({ error: 'Failed to open the portal.' });
  }
};

// Member self-service profile, so a member session survives a page reload.
const getMemberProfile = async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, full_name, email, phone, status FROM members WHERE id = ?',
      [req.user.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    res.json({
      member: { ...rows[0], type: 'member', impersonated: !!req.user.impersonated }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile.' });
  }
};

/**
 * Public self-registration.
 *
 * Creates the member as 'pending'. They cannot log in until an admin approves,
 * which keeps a chama from being flooded by people who joined on their own.
 */
const memberRegister = async (req, res) => {
  try {
    const {
      full_name,
      phone,
      email,
      id_number,
      password,
      confirm_password,
      emergency_contact_name,
      emergency_contact_phone
    } = req.body;

    if (!full_name || !phone || !password) {
      return res.status(400).json({ error: 'Full name, phone and password are required.' });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (confirm_password !== undefined && password !== confirm_password) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (!/^0?7\d{8}$/.test(String(phone).replace(/\s/g, ''))) {
      return res.status(400).json({ error: 'Enter a valid Kenyan phone number, e.g. 0712345678.' });
    }
    if (id_number && String(id_number).length < 6) {
      return res.status(400).json({ error: 'That ID number looks too short.' });
    }

    const cleanPhone = String(phone).replace(/\s/g, '');

    const [existing] = await pool.execute(
      'SELECT id, status FROM members WHERE phone = ?',
      [cleanPhone]
    );
    if (existing.length > 0) {
      const status = existing[0].status;
      if (status === 'pending') {
        return res.status(409).json({
          error: 'You already applied and are waiting for approval.'
        });
      }
      if (status === 'rejected') {
        return res.status(409).json({
          error: 'Your application was declined. Please contact the chama office.'
        });
      }
      return res.status(409).json({ error: 'That phone number is already registered.' });
    }

    if (email) {
      const [emailTaken] = await pool.execute('SELECT id FROM members WHERE email = ?', [email]);
      if (emailTaken.length > 0) {
        return res.status(409).json({ error: 'That email address is already registered.' });
      }
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const [result] = await pool.execute(
      `INSERT INTO members
         (full_name, email, phone, id_number, password_hash, status,
          emergency_contact_name, emergency_contact_phone, joined_date)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, CURDATE())`,
      [
        String(full_name).trim(),
        email || null,
        cleanPhone,
        id_number || null,
        hashedPassword,
        emergency_contact_name || null,
        emergency_contact_phone || null
      ]
    );

    res.status(201).json({
      success: true,
      member_id: result.insertId,
      status: 'pending',
      message:
        'Registration received. An admin will review your application, and you can log in once approved.'
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
};

module.exports = {
  adminLogin,
  memberLogin,
  memberRegister,
  getAdminProfile,
  getMemberProfile,
  changePassword,
  getImpersonationTargets,
  impersonate
};
