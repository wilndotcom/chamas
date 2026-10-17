const bcrypt = require('bcryptjs');
const pool = require('../config/database');

// Get all admins
const getAllAdmins = async (req, res) => {
  try {
    const [admins] = await pool.execute(
      /*
       * member_id is included because admins are also members (migration 016).
       * A screen offering "record a welfare contribution" needs to know which
       * member record is the admin's own: without it the client had no way to
       * offer them as a choice, so an admin could only ever pay into the fund on
       * somebody else's behalf.
       */
      `SELECT a.id, a.member_id, a.full_name, a.username, a.email, a.phone,
              a.is_active, a.last_login, a.created_at, r.name as role_name
       FROM admins a JOIN roles r ON a.role_id = r.id
       ORDER BY a.created_at DESC`
    );
    res.json({ admins });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch admins.' });
  }
};

// Create new admin
const createAdmin = async (req, res) => {
  try {
    const { full_name, username, email, phone, password, role_id } = req.body;

    if (!full_name || !email || !password || !role_id) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    // Usernames are optional; an admin without one signs in with their email.
    let cleanUsername = null;
    if (username && String(username).trim()) {
      cleanUsername = String(username).trim().toLowerCase();

      if (!/^[a-z0-9._-]{3,50}$/.test(cleanUsername)) {
        return res.status(400).json({
          error: 'Username must be 3-50 characters, using letters, numbers, dot, dash or underscore.'
        });
      }

      const [taken] = await pool.execute('SELECT id FROM admins WHERE username = ?', [
        cleanUsername
      ]);
      if (taken.length > 0) {
        return res.status(409).json({ error: 'That username is already taken.' });
      }
    }

    // Check if email exists
    const [existing] = await pool.execute('SELECT id FROM admins WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'Email already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    /*
     * An admin is also a member, so the two records are created together.
     *
     * Without this an admin could not contribute, borrow, or appear in any member
     * list, which is not how a chama works: the chair and treasurer save like
     * everyone else. Their member row reuses the same password hash, so they sign
     * in to the member portal with the credentials they already have rather than
     * being handed a second set.
     *
     * Phone and email are only claimed when no member already holds them, because
     * both are UNIQUE and a real member may well have registered with the same
     * number the admin uses. When they collide the member row is still created
     * with a generated number, so the link is never missing.
     */
    const conn = await pool.getConnection();
    let adminId;
    try {
      await conn.beginTransaction();

      const [result] = await conn.execute(
        /*
         * Flagged for a first-sign-in change, because the password was chosen by
         * whoever created the account rather than by the person who will use it.
         * Until they replace it the account is a credential two people know.
         */
        'INSERT INTO admins (full_name, username, email, phone, password_hash, role_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1)',
        [full_name, cleanUsername, email, phone || null, hashedPassword, role_id]
      );
      adminId = result.insertId;

      const phoneTaken = phone
        ? (await conn.execute('SELECT 1 FROM members WHERE phone = ?', [phone]))[0].length > 0
        : true;
      const emailTaken = (await conn.execute('SELECT 1 FROM members WHERE email = ?', [email]))[0].length > 0;

      const memberPhone = phoneTaken ? `9000000${String(adminId).padStart(4, '0')}` : phone;

      const [member] = await conn.execute(
        `INSERT INTO members (full_name, email, phone, password_hash, status, joined_date)
         VALUES (?, ?, ?, ?, 'active', CURDATE())`,
        [full_name, emailTaken ? null : email, memberPhone, hashedPassword]
      );

      await conn.execute('UPDATE admins SET member_id = ? WHERE id = ?', [member.insertId, adminId]);

      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }

    res.status(201).json({
      success: true,
      admin_id: adminId,
      message: 'Admin created successfully.'
    });
  } catch (error) {
    console.error('Create admin error:', error);
    res.status(500).json({ error: 'Failed to create admin.' });
  }
};

// Update admin
const updateAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, username, email, phone, role_id, is_active } = req.body;

    // An omitted or blank username clears it, which puts that admin back on
    // email-only sign-in rather than leaving a stale value behind.
    let nextUsername = null;
    if (username && String(username).trim()) {
      nextUsername = String(username).trim().toLowerCase();

      if (!/^[a-z0-9._-]{3,50}$/.test(nextUsername)) {
        return res.status(400).json({
          error: 'Username must be 3-50 characters, using letters, numbers, dot, dash or underscore.'
        });
      }

      const [taken] = await pool.execute(
        'SELECT id FROM admins WHERE username = ? AND id <> ?',
        [nextUsername, id]
      );
      if (taken.length > 0) {
        return res.status(409).json({ error: 'That username is already taken.' });
      }
    }

    await pool.execute(
      'UPDATE admins SET full_name = ?, username = ?, email = ?, phone = ?, role_id = ?, is_active = ? WHERE id = ?',
      [full_name, nextUsername, email, phone, role_id, is_active, id]
    );

    res.json({ success: true, message: 'Admin updated successfully.' });
  } catch (error) {
    console.error('Update admin error:', error);
    res.status(500).json({ error: 'Failed to update admin.' });
  }
};

// Delete admin
const deleteAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    // Prevent self-deletion
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }

    await pool.execute('DELETE FROM admins WHERE id = ?', [id]);
    res.json({ success: true, message: 'Admin deleted successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete admin.' });
  }
};

// Get all roles
const getRoles = async (req, res) => {
  try {
    const [roles] = await pool.execute('SELECT * FROM roles ORDER BY id');
    res.json({ roles });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch roles.' });
  }
};

// Get audit logs
const getAuditLogs = async (req, res) => {
  try {
    const [logs] = await pool.execute(
      `SELECT al.*, a.full_name as admin_name, m.full_name as member_name
       FROM audit_logs al
       LEFT JOIN admins a ON al.admin_id = a.id
       LEFT JOIN members m ON al.member_id = m.id
       ORDER BY al.created_at DESC LIMIT 100`
    );
    res.json({ logs });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch audit logs.' });
  }
};

module.exports = {
  getAllAdmins,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  getRoles,
  getAuditLogs
};
