import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import {
  ShieldCheck,
  Plus,
  Save,
  Trash2,
  Edit3,
  Lock,
  RefreshCw,
  Inbox,
  AlertTriangle,
  Users,
  Check,
  X,
  UserCog
} from 'lucide-react';
import { useI18n, dictionaries } from '../i18n/I18nContext';

/**
 * Display wording for values the API sends.
 *
 * Role names, permission names, categories and descriptions are all stored
 * server-side and sent back verbatim; the app sends those raw values on save and
 * compares them against them, so none of that is touched here. Only the label
 * an admin reads is looked up, and anything not in these maps falls back to the
 * server's own English text rather than printing a raw key.
 */
const ROLE_NAME_KEYS = {
  super_admin: 'roles.superAdmin',
  treasurer: 'roles.treasurer',
  chairperson: 'roles.chairperson',
  secretary: 'roles.secretary',
  admin: 'roles.admin'
};

/** Returns null when the key is unknown, so callers can fall back cleanly. */
const lookup = (t, key) => (key && dictionaries.en[key] !== undefined ? t(key) : null);

const roleLabel = (t, name) =>
  lookup(t, ROLE_NAME_KEYS[name]) || String(name || '').replace(/_/g, ' ');

const permLabel = (t, name) => lookup(t, `roles.perm.${name}`) || name.replace(/_/g, ' ');

const permDesc = (t, name, fallback) =>
  lookup(t, `roles.permDesc.${name}`) || fallback;

// Categories arrive title-cased ("Members"); the keys are lower case.
const categoryLabel = (t, name) => lookup(t, `roles.cat.${String(name).toLowerCase()}`) || name;

/**
 * Roles & rights.
 *
 * Lives inside Settings now rather than as its own admin menu entry, because it
 * is a configuration screen rather than day-to-day work.
 *
 * `embedded` drops the page-level <h1>: Settings already has a page title, and
 * two of them on one screen is worse than none. The action buttons stay.
 */
const RolesPermissions = ({ embedded = false }) => {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(null);
  const [showNewRole, setShowNewRole] = useState(false);
  const [newRole, setNewRole] = useState({ name: '', description: '', permissions: [] });
  const [editingRole, setEditingRole] = useState(null);
  const [overrideFor, setOverrideFor] = useState(null);
  const [admins, setAdmins] = useState([]);

  const load = async () => {
    setLoading(true);
    try {
      const [rolesRes, adminsRes] = await Promise.all([
        axios.get('/api/roles'),
        axios.get('/api/admins')
      ]);
      setData(rolesRes.data);
      setAdmins(adminsRes.data.admins);
    } catch (error) {
      toast.error(error.response?.data?.error || t('roles.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  /** Group permissions by category so the matrix stays readable. */
  const grouped = () => {
    const out = {};
    data.permissions.forEach((p) => {
      out[p.category] = out[p.category] || [];
      out[p.category].push(p);
    });
    return out;
  };

  const togglePermission = async (role, permName) => {
    if (role.locked) return;
    const has = role.permissions.includes(permName);
    const next = has
      ? role.permissions.filter((p) => p !== permName)
      : [...role.permissions, permName];

    // Guard client-side too, but the server is the real authority.
    if (next.length === 0) {
      toast.error(t('roles.needsPermission'));
      return;
    }

    setSaving(`${role.id}-${permName}`);
    try {
      await axios.put(`/api/roles/${role.id}/permissions`, { permissions: next });
      setData((d) => ({
        ...d,
        roles: d.roles.map((r) =>
          r.id === role.id ? { ...r, permissions: next } : r
        )
      }));
      toast.success(
        t(has ? 'roles.removed' : 'roles.granted', {
          role: roleLabel(t, role.name),
          perm: permLabel(t, permName)
        })
      );
    } catch (error) {
      toast.error(error.response?.data?.error || t('roles.updateFailed'));
    } finally {
      setSaving(null);
    }
  };

  const createRole = async (e) => {
    e.preventDefault();
    try {
      const res = await axios.post('/api/roles', newRole);
      toast.success(res.data.message);
      setShowNewRole(false);
      setNewRole({ name: '', description: '', permissions: [] });
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || t('roles.createFailed'));
    }
  };

  const renameRole = async (e) => {
    e.preventDefault();
    try {
      const res = await axios.put(`/api/roles/${editingRole.id}`, {
        name: editingRole.name,
        description: editingRole.description
      });
      toast.success(res.data.message);
      setEditingRole(null);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || t('roles.renameFailed'));
    }
  };

  const deleteRole = async (role) => {
    if (!confirm(t('roles.deleteConfirmPrompt', { name: roleLabel(t, role.name) }))) return;
    try {
      const res = await axios.delete(`/api/roles/${role.id}`);
      toast.success(res.data.message);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || t('roles.deleteFailed'));
    }
  };

  if (loading) {
    return (
      <div className="card">
        <div className="empty-state">
          <Inbox size={36} />
          <p>{t('roles.loading')}</p>
        </div>
      </div>
    );
  }

  const categories = grouped();

  const actions = (
    <div className="page-actions">
      <button className="btn btn-secondary" onClick={load}>
        <RefreshCw size={16} /> {t('common.refresh')}
      </button>
      <button className="btn btn-primary" onClick={() => setShowNewRole(true)}>
        <Plus size={17} /> {t('roles.addRole')}
      </button>
    </div>
  );

  return (
    <div>
      {embedded ? (
        /* Section header only, so it reads as part of Settings. */
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-header" style={{ marginBottom: 12 }}>
            <h3 className="card-title">
              <ShieldCheck size={18} /> {t('roles.title')}
            </h3>
            {actions}
          </div>
          <p style={{ fontSize: 13.5, color: 'var(--text-soft)', lineHeight: 1.65 }}>
            {t('roles.subtitleNote')}
          </p>
        </div>
      ) : (
        <div className="page-header">
          <div>
            <h1 className="page-title">{t('roles.title')}</h1>
            <p className="page-sub">{t('roles.subtitle')}</p>
          </div>
          {actions}
        </div>
      )}

      <div className="notice-strip" style={{ marginBottom: 22 }}>
        <ShieldCheck size={16} />
        <span>{t('roles.matrixNote')}</span>
      </div>

      {/* ------------------------------------------------- permission matrix */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <ShieldCheck size={18} /> {t('roles.matrix')}
          </h3>
          <span className="badge badge-neutral">
            {t('roles.permissionCount', { n: data.permissions.length })}
          </span>
        </div>

        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th className="matrix-perm-col">{t('roles.permission')}</th>
                {data.roles.map((r) => (
                  <th key={r.id} className="matrix-role-col">
                    <div className="matrix-role-name">
                      {r.locked && <Lock size={11} />}
                      {roleLabel(t, r.name)}
                    </div>
                    <div className="matrix-role-count">
                      {r.permissions.length} ·{' '}
                      {t(r.admin_count === 1 ? 'roles.adminCount' : 'roles.adminCountPlural', {
                        n: r.admin_count
                      })}
                    </div>
                    {!r.is_system && (
                      <div className="matrix-role-actions">
                        <button
                          className="matrix-mini"
                          onClick={() =>
                            setEditingRole({
                              id: r.id,
                              name: r.name,
                              description: r.description
                            })
                          }
                          title={t('roles.rename')}
                        >
                          <Edit3 size={12} />
                        </button>
                        <button
                          className="matrix-mini matrix-mini--danger"
                          onClick={() => deleteRole(r)}
                          title={t('common.delete')}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.entries(categories).map(([category, perms]) => (
                <React.Fragment key={category}>
                  <tr className="matrix-category-row">
                    <td colSpan={data.roles.length + 1}>{categoryLabel(t, category)}</td>
                  </tr>
                  {perms.map((p) => (
                    <tr key={p.id}>
                      <td className="matrix-perm-col">
                        <div className="matrix-perm-name">{permLabel(t, p.name)}</div>
                        <div className="matrix-perm-desc">
                          {permDesc(t, p.name, p.description)}
                        </div>
                      </td>
                      {data.roles.map((r) => {
                        const on = r.permissions.includes(p.name);
                        const busy = saving === `${r.id}-${p.name}`;
                        return (
                          <td key={r.id} className="matrix-cell">
                            <button
                              className={`matrix-check${on ? ' on' : ''}${r.locked ? ' locked' : ''}`}
                              onClick={() => togglePermission(r, p.name)}
                              disabled={r.locked || busy}
                              aria-label={t('roles.adminFor', {
                                perm: permLabel(t, p.name),
                                role: roleLabel(t, r.name)
                              })}
                              title={r.locked ? t('roles.superAlwaysAll') : undefined}
                            >
                              {busy ? (
                                <span className="spinner" />
                              ) : on ? (
                                <Check size={15} />
                              ) : (
                                <X size={15} />
                              )}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ------------------------------------------- per-admin custom rights */}
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">
              <UserCog size={18} /> {t('roles.perAdmin')}
            </h3>
            <p className="card-sub">{t('roles.perAdminNote')}</p>
          </div>
        </div>

        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>{t('roles.admin')}</th>
                <th>{t('roles.role')}</th>
                <th style={{ width: 200 }}>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{a.full_name}</div>
                    <div style={{ fontSize: 12, color: '#64748b' }}>{a.email}</div>
                  </td>
                  <td>
                    <span className="badge badge-info">{roleLabel(t, a.role_name)}</span>
                  </td>
                  <td>
                    {a.role_name === 'super_admin' ? (
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>
                        <Lock size={12} style={{ verticalAlign: -2 }} /> {t('roles.alwaysFull')}
                      </span>
                    ) : (
                      <button
                        className="btn btn-sm btn-secondary"
                        onClick={() => setOverrideFor(a)}
                      >
                        <UserCog size={14} /> {t('roles.customPermissions')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* ------------------------------------------------------ new role modal */}
      {showNewRole && (
        <div className="modal-overlay" onClick={() => setShowNewRole(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('roles.addRole')}</h2>
              <button className="modal-close" onClick={() => setShowNewRole(false)}>
                &times;
              </button>
            </div>

            <form onSubmit={createRole}>
              <div className="form-group">
                <label>{t('roles.roleName')} *</label>
                <input
                  type="text"
                  value={newRole.name}
                  onChange={(e) => setNewRole({ ...newRole, name: e.target.value })}
                  placeholder={t('roles.roleNamePlaceholder')}
                  required
                />
                <small style={{ color: '#94a3b8', fontSize: 12 }}>
                  {t('roles.roleNameHint')}
                </small>
              </div>

              <div className="form-group">
                <label>{t('common.description')}</label>
                <input
                  type="text"
                  value={newRole.description}
                  onChange={(e) => setNewRole({ ...newRole, description: e.target.value })}
                  placeholder={t('roles.descriptionPlaceholder')}
                />
              </div>

              <div className="form-group">
                <label>{t('common.permissions')} *</label>
                <div className="perm-picker">
                  {Object.entries(categories).map(([cat, perms]) => (
                    <div key={cat} className="perm-picker-group">
                      <div className="perm-picker-cat">{categoryLabel(t, cat)}</div>
                      {perms.map((p) => {
                        const on = newRole.permissions.includes(p.name);
                        return (
                          <button
                            type="button"
                            key={p.id}
                            className={`perm-picker-item${on ? ' on' : ''}`}
                            onClick={() =>
                              setNewRole({
                                ...newRole,
                                permissions: on
                                  ? newRole.permissions.filter((x) => x !== p.name)
                                  : [...newRole.permissions, p.name]
                              })
                            }
                          >
                            {on ? <Check size={13} /> : <X size={13} />}
                            {permLabel(t, p.name)}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <button
                type="submit"
                className="btn btn-primary btn-block"
                disabled={newRole.permissions.length === 0}
              >
                {t('roles.createRole')}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------- rename modal */}
      {editingRole && (
        <div className="modal-overlay" onClick={() => setEditingRole(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('roles.renameRole')}</h2>
              <button className="modal-close" onClick={() => setEditingRole(null)}>
                &times;
              </button>
            </div>
            <form onSubmit={renameRole}>
              <div className="form-group">
                <label>{t('roles.roleName')} *</label>
                <input
                  type="text"
                  value={editingRole.name}
                  onChange={(e) => setEditingRole({ ...editingRole, name: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('common.description')}</label>
                <input
                  type="text"
                  value={editingRole.description || ''}
                  onChange={(e) =>
                    setEditingRole({ ...editingRole, description: e.target.value })
                  }
                />
              </div>
              <button type="submit" className="btn btn-primary btn-block">
                {t('common.save')}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* --------------------------------------------- per-admin rights modal */}
      {overrideFor && (
        <AdminRightsModal
          admin={overrideFor}
          onClose={() => setOverrideFor(null)}
          onSaved={load}
        />
      )}
    </div>
  );
};

const AdminRightsModal = ({ admin, onClose, onSaved }) => {
  const { t } = useI18n();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [overrides, setOverrides] = useState({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await axios.get(`/api/admin-permissions/${admin.id}`);
        setInfo(data);
        const map = {};
        data.overrides.forEach((o) => {
          map[o.name] = o.mode;
        });
        setOverrides(map);
      } catch (error) {
        toast.error(error.response?.data?.error || t('roles.rightsLoadFailed'));
        onClose();
      } finally {
        setLoading(false);
      }
    })();
  }, [admin.id, onClose]);

  /**
   * Three states per permission: inherited from the role, explicitly granted,
   * or explicitly revoked. Anything untouched is left to the role.
   */
  const cycle = (name, roleHas) => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (!next[name]) {
        next[name] = roleHas ? 'revoke' : 'grant';
      } else if (next[name] === 'revoke') {
        delete next[name];
      } else {
        next[name] = 'revoke';
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const list = Object.entries(overrides).map(([name, mode]) => ({ name, mode }));
      const res = await axios.put(`/api/admin-permissions/${admin.id}`, {
        overrides: list
      });
      toast.success(res.data.message);
      onSaved();
      onClose();
    } catch (error) {
      toast.error(error.response?.data?.error || t('err.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const byCategory = {};
  (info?.permissions || []).forEach((p) => {
    byCategory[p.category] = byCategory[p.category] || [];
    byCategory[p.category].push(p);
  });

  const changedCount = Object.keys(overrides).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t('roles.customRightsFor', { name: admin.full_name })}</h2>
          <button className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {loading ? (
          <div className="empty-state">
            <Inbox size={30} />
            <p>{t('common.loading')}</p>
          </div>
        ) : (
          <>
            <div className="notice-strip" style={{ marginBottom: 16 }}>
              <UserCog size={16} />
              <span>{t('roles.startsFrom', { role: roleLabel(t, info.admin.role_name) })}</span>
            </div>

            {Object.entries(byCategory).map(([cat, perms]) => (
              <div key={cat} className="perm-picker-group" style={{ marginBottom: 14 }}>
                <div className="perm-picker-cat">{categoryLabel(t, cat)}</div>
                {perms.map((p) => {
                  const roleHas = info.role_permissions.includes(p.name);
                  const ov = overrides[p.name];
                  const state = ov || (roleHas ? 'role' : 'none');
                  return (
                    <button
                      key={p.id}
                      className={`perm-picker-item state-${state}`}
                      onClick={() => cycle(p.name, roleHas)}
                    >
                      <span className="perm-state-mark">
                        {state === 'grant' && <Check size={13} />}
                        {state === 'revoke' && <X size={13} />}
                      </span>
                      <span className="perm-state-label">{permLabel(t, p.name)}</span>
                      <span className="perm-state-tag">
                        {state === 'grant'
                          ? t('roles.state.grantedExtra')
                          : state === 'revoke'
                            ? t('roles.state.removed')
                            : roleHas
                              ? t('roles.state.fromRole')
                              : t('roles.state.notAllowed')}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}

            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" onClick={save} disabled={saving}>
                {saving
                  ? t('common.saving')
                  : `${t('common.save')}${changedCount ? ` (${changedCount})` : ''}`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default RolesPermissions;