const pool = require('../config/database');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const audit = async (adminId, action, details, ip) => {
  await pool.execute(
    'INSERT INTO audit_logs (admin_id, action, details, ip_address) VALUES (?, ?, ?, ?)',
    [adminId, action, JSON.stringify(details), ip || null]
  );
};

/** Roles with their permissions and how many admins hold each. */
const getRoles = async (req, res) => {
  try {
    const [roles] = await pool.execute(
      `SELECT r.id, r.name, r.description, r.is_system,
              (SELECT COUNT(*) FROM admins a WHERE a.role_id = r.id) AS admin_count
       FROM roles r ORDER BY r.is_system DESC, r.id`
    );

    const [links] = await pool.execute(
      `SELECT rp.role_id, p.id AS permission_id, p.name
       FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id`
    );

    const [permissions] = await pool.execute(
      'SELECT id, name, description, category FROM permissions ORDER BY category, name'
    );

    const byRole = {};
    links.forEach((l) => {
      byRole[l.role_id] = byRole[l.role_id] || [];
      byRole[l.role_id].push(l.name);
    });

    res.json({
      roles: roles.map((r) => ({
        ...r,
        permissions: byRole[r.id] || [],
        locked: r.name === 'super_admin'
      })),
      permissions
    });
  } catch (error) {
    console.error('Get roles error:', error);
    res.status(500).json({ error: 'Failed to load roles.' });
  }
};

/** Replace the permission set of a role. */
const setRolePermissions = async (req, res) => {
  try {
    const { id } = req.params;
    const { permissions } = req.body;

    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'permissions must be an array of names.' });
    }

    const [roles] = await pool.execute('SELECT id, name, is_system FROM roles WHERE id = ?', [id]);
    if (roles.length === 0) {
      return res.status(404).json({ error: 'Role not found.' });
    }

    // The super admin must keep every permission, otherwise nobody could ever
    // restore them and the system would be permanently locked.
    if (roles[0].name === 'super_admin') {
      const [all] = await pool.execute('SELECT id FROM permissions');
      await pool.execute('DELETE FROM role_permissions WHERE role_id = ?', [id]);
      if (all.length > 0) {
        await pool.query(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES ?',
          [all.map((p) => [id, p.id])]
        );
      }
      await audit(req.user.id, 'super_admin_permissions_reset', { role_id: id }, req.ip);
      return res.json({ success: true, message: 'Super admin always keeps every permission.' });
    }

    if (permissions.length === 0) {
      return res.status(400).json({
        error: 'A role needs at least one permission, otherwise nobody using it can do anything.'
      });
    }

    const [valid] = await pool.query(
      'SELECT id, name FROM permissions WHERE name IN (?)',
      [permissions]
    );
    if (valid.length !== permissions.length) {
      const known = valid.map((v) => v.name);
      const unknown = permissions.filter((p) => !known.includes(p));
      return res.status(400).json({ error: `Unknown permission(s): ${unknown.join(', ')}` });
    }

    await pool.execute('DELETE FROM role_permissions WHERE role_id = ?', [id]);
    await pool.query(
      'INSERT INTO role_permissions (role_id, permission_id) VALUES ?',
      [valid.map((p) => [id, p.id])]
    );

    await audit(
      req.user.id,
      'role_permissions_updated',
      { role: roles[0].name, permissions },
      req.ip
    );

    res.json({
      success: true,
      message: `${roles[0].name} now has ${valid.length} permission(s).`,
      permissions: valid.map((v) => v.name)
    });
  } catch (error) {
    console.error('Set role permissions error:', error);
    res.status(500).json({ error: 'Failed to update the role.' });
  }
};

const createRole = async (req, res) => {
  try {
    const { name, description, permissions } = req.body;

    const cleanName = String(name || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!cleanName) {
      return res.status(400).json({ error: 'Role name is required.' });
    }
    if (!/^[a-z][a-z0-9_]{2,39}$/.test(cleanName)) {
      return res.status(400).json({
        error: 'Use 3-40 characters: lowercase letters, numbers and underscores.'
      });
    }
    if (!Array.isArray(permissions) || permissions.length === 0) {
      return res.status(400).json({ error: 'Pick at least one permission.' });
    }

    const [existing] = await pool.execute('SELECT id FROM roles WHERE name = ?', [cleanName]);
    if (existing.length > 0) {
      return res.status(409).json({ error: 'A role with that name already exists.' });
    }

    const [valid] = await pool.query(
      'SELECT id, name FROM permissions WHERE name IN (?)',
      [permissions]
    );

    const [result] = await pool.execute(
      'INSERT INTO roles (name, description, is_system) VALUES (?, ?, 0)',
      [cleanName, description || `Custom role: ${cleanName}`]
    );

    if (valid.length > 0) {
      await pool.query(
        'INSERT INTO role_permissions (role_id, permission_id) VALUES ?',
        [valid.map((p) => [result.insertId, p.id])]
      );
    }

    await audit(req.user.id, 'role_created', { name: cleanName, permissions: valid.map((v) => v.name) }, req.ip);

    res.status(201).json({
      success: true,
      role_id: result.insertId,
      role: { id: result.insertId, name: cleanName, description: description || null, is_system: 0 },
      message: `Role "${cleanName}" created.`
    });
  } catch (error) {
    console.error('Create role error:', error);
    res.status(500).json({ error: 'Failed to create the role.' });
  }
};

const updateRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const [roles] = await pool.execute('SELECT id, name, is_system FROM roles WHERE id = ?', [id]);
    if (roles.length === 0) {
      return res.status(404).json({ error: 'Role not found.' });
    }
    if (roles[0].is_system) {
      return res.status(400).json({
        error: 'Built-in roles cannot be renamed. Permissions can still be changed.'
      });
    }

    const cleanName = String(name || '').trim().toLowerCase().replace(/\s+/g, '_');
    if (!/^[a-z][a-z0-9_]{2,39}$/.test(cleanName)) {
      return res.status(400).json({
        error: 'Use 3-40 characters: lowercase letters, numbers and underscores.'
      });
    }

    const [clash] = await pool.execute(
      'SELECT id FROM roles WHERE name = ? AND id <> ?',
      [cleanName, id]
    );
    if (clash.length > 0) {
      return res.status(409).json({ error: 'A role with that name already exists.' });
    }

    await pool.execute(
      'UPDATE roles SET name = ?, description = ? WHERE id = ?',
      [cleanName, description || null, id]
    );

    await audit(req.user.id, 'role_updated', { role_id: Number(id), name: cleanName }, req.ip);

    res.json({ success: true, message: 'Role updated.' });
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ error: 'Failed to update the role.' });
  }
};

const deleteRole = async (req, res) => {
  try {
    const { id } = req.params;

    const [roles] = await pool.execute('SELECT id, name, is_system FROM roles WHERE id = ?', [id]);
    if (roles.length === 0) {
      return res.status(404).json({ error: 'Role not found.' });
    }
    if (roles[0].is_system) {
      return res.status(400).json({ error: 'Built-in roles cannot be deleted.' });
    }

    const [inUse] = await pool.execute(
      'SELECT COUNT(*) AS c FROM admins WHERE role_id = ?',
      [id]
    );
    if (inUse[0].c > 0) {
      return res.status(400).json({
        error: `${inUse[0].c} admin(s) still use this role. Reassign them first.`
      });
    }

    await pool.execute('DELETE FROM role_permissions WHERE role_id = ?', [id]);
    await pool.execute('DELETE FROM roles WHERE id = ?', [id]);

    await audit(req.user.id, 'role_deleted', { role: roles[0].name }, req.ip);

    res.json({ success: true, message: `Role "${roles[0].name}" deleted.` });
  } catch (error) {
    console.error('Delete role error:', error);
    res.status(500).json({ error: 'Failed to delete the role.' });
  }
};

/* ------------------------------------------------- per-admin overrides --- */

const getAdminOverrides = async (req, res) => {
  try {
    const id = req.params.adminId;

    const [admins] = await pool.execute(
      `SELECT a.id, a.full_name, a.email, a.role_id, r.name AS role_name
       FROM admins a JOIN roles r ON a.role_id = r.id WHERE a.id = ?`,
      [id]
    );
    if (admins.length === 0) {
      return res.status(404).json({ error: 'Admin not found.' });
    }

    const [overrides] = await pool.execute(
      `SELECT p.name, o.mode
       FROM admin_permission_overrides o
       JOIN permissions p ON p.id = o.permission_id
       WHERE o.admin_id = ?`,
      [id]
    );

    const [rolePerms] = await pool.execute(
      `SELECT p.name
       FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ?`,
      [admins[0].role_id]
    );

    const [permissions] = await pool.execute(
      'SELECT id, name, description, category FROM permissions ORDER BY category, name'
    );

    res.json({
      admin: {
        ...admins[0],
        is_super_admin: admins[0].role_name === 'super_admin'
      },
      role_permissions: rolePerms.map((r) => r.name),
      overrides: overrides.map((o) => ({ name: o.name, mode: o.mode })),
      permissions
    });
  } catch (error) {
    console.error('Get admin overrides error:', error);
    res.status(500).json({ error: 'Failed to load admin permissions.' });
  }
};

const setAdminOverrides = async (req, res) => {
  try {
    const id = req.params.adminId;
    const { overrides } = req.body;

    if (!Array.isArray(overrides)) {
      return res.status(400).json({ error: 'overrides must be an array.' });
    }

    const [admins] = await pool.execute(
      `SELECT a.id, a.full_name, r.name AS role_name
       FROM admins a JOIN roles r ON a.role_id = r.id WHERE a.id = ?`,
      [id]
    );
    if (admins.length === 0) {
      return res.status(404).json({ error: 'Admin not found.' });
    }
    if (admins[0].role_name === 'super_admin') {
      return res.status(400).json({
        error: 'The super admin keeps every permission and cannot be restricted.'
      });
    }

    const bad = overrides.filter((o) => !['grant', 'revoke'].includes(o.mode));
    if (bad.length > 0) {
      return res.status(400).json({ error: 'Each override needs mode "grant" or "revoke".' });
    }

    await pool.execute('DELETE FROM admin_permission_overrides WHERE admin_id = ?', [id]);

    // An empty overrides array means "clear them", so there is nothing to look up.
    if (overrides.length > 0) {
      const [valid] = await pool.query(
        'SELECT id, name FROM permissions WHERE name IN (?)',
        [overrides.map((o) => o.name)]
      );
      const rows = valid
        .map((p) => {
          const match = overrides.find((o) => o.name === p.name);
          return match ? [id, p.id, match.mode] : null;
        })
        .filter(Boolean);
      if (rows.length > 0) {
        await pool.query(
          'INSERT INTO admin_permission_overrides (admin_id, permission_id, mode) VALUES ?',
          [rows]
        );
      }
    }

    await audit(
      req.user.id,
      'admin_permissions_updated',
      { admin: admins[0].full_name, overrides: overrides.map((o) => `${o.mode}:${o.name}`) },
      req.ip
    );

    res.json({
      success: true,
      message: `Custom rights saved for ${admins[0].full_name}.`,
      overrides: overrides.length
    });
  } catch (error) {
    console.error('Set admin overrides error:', error);
    res.status(500).json({ error: 'Failed to save the admin permissions.' });
  }
};

module.exports = {
  getRoles,
  setRolePermissions,
  createRole,
  updateRole,
  deleteRole,
  getAdminOverrides,
  setAdminOverrides
};