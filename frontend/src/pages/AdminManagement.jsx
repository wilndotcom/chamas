import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Plus, Edit, Trash2, Shield } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

const AdminManagement = () => {
  const { t } = useI18n();
  const [admins, setAdmins] = useState([]);
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingAdmin, setEditingAdmin] = useState(null);
  const [form, setForm] = useState({
    full_name: '',
    username: '',
    email: '',
    phone: '',
    password: '',
    role_id: ''
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [adminsRes, rolesRes] = await Promise.all([
        axios.get('/api/admins'),
        axios.get('/api/admins/roles')
      ]);
      setAdmins(adminsRes.data.admins);
      setRoles(rolesRes.data.roles);
    } catch (error) {
      toast.error(t('admins.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingAdmin) {
        await axios.put(`/api/admins/${editingAdmin.id}`, form);
        toast.success(t('admins.updated'));
      } else {
        await axios.post('/api/admins', form);
        toast.success(t('admins.created'));
      }
      setShowModal(false);
      resetForm();
      fetchData();
    } catch (error) {
      toast.error(error.response?.data?.error || t('common.operationFailed'));
    }
  };

  const handleDelete = async (id) => {
    if (!confirm(t('admins.deleteConfirm'))) return;
    try {
      await axios.delete(`/api/admins/${id}`);
      toast.success(t('admins.deleted'));
      fetchData();
    } catch (error) {
      toast.error(t('admins.deleteFailed'));
    }
  };

  const handleEdit = (admin) => {
    setEditingAdmin(admin);
    setForm({
      full_name: admin.full_name,
      username: admin.username || '',
      email: admin.email,
      phone: admin.phone || '',
      password: '',
      role_id: admin.role_id
    });
    setShowModal(true);
  };

  const resetForm = () => {
    setForm({
      full_name: '',
      username: '',
      email: '',
      phone: '',
      password: '',
      role_id: ''
    });
    setEditingAdmin(null);
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>{t('admins.title')}</h1>
        <button className="btn btn-primary" onClick={() => { resetForm(); setShowModal(true); }}>
          <Plus size={18} /> {t('admins.add')}
        </button>
      </div>

      <div className="card">
        {loading ? (
          <p>{t('common.loading')}</p>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('admins.username')}</th>
                  <th>{t('common.email')}</th>
                  <th>{t('common.phone')}</th>
                  <th>{t('admins.role')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('admins.lastLogin')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {admins.map((admin) => (
                  <tr key={admin.id}>
                    <td>{admin.full_name}</td>
                    <td style={{ fontWeight: 600 }}>{admin.username || '-'}</td>
                    <td>{admin.email}</td>
                    <td>{admin.phone || '-'}</td>
                    <td>
                      <span className="badge badge-info">
                        <Shield size={12} style={{ marginRight: 4 }} />
                        {admin.role_name}
                      </span>
                    </td>
                    <td>
                      <span className={`badge badge-${admin.is_active ? 'success' : 'danger'}`}>
                        {admin.is_active ? t('status.active') : t('status.inactive')}
                      </span>
                    </td>
                    <td>{admin.last_login ? new Date(admin.last_login).toLocaleDateString() : t('common.never')}</td>
                    <td>
                      <button className="btn btn-sm btn-secondary" onClick={() => handleEdit(admin)}>
                        <Edit size={14} />
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => handleDelete(admin.id)} style={{ marginLeft: 8 }}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingAdmin ? t('admins.edit') : t('admins.addNew')}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>{t('members.fullName')} *</label>
                <input
                  type="text"
                  value={form.full_name}
                  onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('admins.username')}</label>
                <input
                  type="text"
                  value={form.username || ''}
                  onChange={(e) => setForm({ ...form, username: e.target.value })}
                  placeholder={t('admins.usernamePlaceholder')}
                  autoCapitalize="none"
                  autoCorrect="off"
                />
                <small className="field-hint">{t('admins.usernameHint')}</small>
              </div>
              <div className="form-group">
                <label>{t('common.email')} *</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('common.phone')}</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>{t('admins.role')} *</label>
                <select
                  value={form.role_id}
                  onChange={(e) => setForm({ ...form, role_id: e.target.value })}
                  required
                >
                  <option value="">{t('admins.selectRole')}</option>
                  {roles.map((role) => (
                    <option key={role.id} value={role.id}>{role.name}</option>
                  ))}
                </select>
              </div>
              {!editingAdmin && (
                <div className="form-group">
                  <label>{t('common.password')} *</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required={!editingAdmin}
                    minLength={8}
                  />
                </div>
              )}
              <button type="submit" className="btn btn-primary">
                {editingAdmin ? t('admins.update') : t('admins.create')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdminManagement;
