import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Plus, Edit, Trash2, Search, UserX, UserCheck, AlertTriangle, ShieldAlert } from 'lucide-react';
import { useI18n, translate } from '../i18n/I18nContext';

/**
 * The API describes what blocks a delete as English phrases such as
 * "3 contributions". The count is data, but the noun is ours to translate, so
 * each phrase is rebuilt as "<count> <translated noun>". Anything the server
 * invents later has no entry here and passes through untouched.
 */
const HISTORY_NOUN_KEYS = {
  contribution: 'members.history.contribution',
  contributions: 'members.history.contributions',
  loan: 'members.history.loan',
  loans: 'members.history.loans',
  'loan repayment': 'members.history.loanRepayment',
  'loan repayments': 'members.history.loanRepayments',
  'welfare contribution': 'members.history.welfareContribution',
  'welfare contributions': 'members.history.welfareContributions',
  'welfare request': 'members.history.welfareRequest',
  'welfare requests': 'members.history.welfareRequests',
  'ledger entry': 'members.history.ledgerEntry',
  'ledger entries': 'members.history.ledgerEntries',
  'audit log entry': 'members.history.auditLogEntry',
  'audit log entries': 'members.history.auditLogEntries'
};

const describeHistory = (blockers = []) =>
  blockers
    .map((phrase) => {
      const parts = phrase.match(/^(\d+)\s+(.+)$/);
      const key = parts && HISTORY_NOUN_KEYS[parts[2]];
      return key ? `${parts[1]} ${translate(key)}` : phrase;
    })
    .join(', ');

const Members = () => {
  const { t } = useI18n();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingMember, setEditingMember] = useState(null);
  // Member currently being removed or deactivated, plus the dialog's own state.
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState(null);
  const [search, setSearch] = useState('');
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    id_number: '',
    password: '',
    emergency_contact_name: '',
    emergency_contact_phone: ''
  });

  useEffect(() => {
    fetchMembers();
  }, []);

  const fetchMembers = async () => {
    try {
      const response = await axios.get('/api/members');
      setMembers(response.data.members);
    } catch (error) {
      toast.error(t('members.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      if (editingMember) {
        await axios.put(`/api/members/${editingMember.id}`, form);
        toast.success(t('members.updated'));
      } else {
        await axios.post('/api/members', form);
        toast.success(t('members.added'));
      }
      setShowModal(false);
      resetForm();
      fetchMembers();
    } catch (error) {
      toast.error(error.response?.data?.error || t('common.operationFailed'));
    }
  };

  /**
   * Removing a member is destructive, so the dialog has to say what will
   * actually happen rather than a generic "are you sure".
   *
   * A member with savings or loan history cannot be deleted at all - those rows
   * are the ledger. For them the dialog offers Deactivate instead, which stops
   * sign-in and keeps every record intact.
   */
  const openRemoveDialog = (member) => {
    setRemoveTarget(member);
    setRemoveError(null);
  };

  const closeRemoveDialog = () => {
    setRemoveTarget(null);
    setRemoveError(null);
    setRemoveBusy(false);
  };

  const handleDelete = async () => {
    if (!removeTarget) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      const { data } = await axios.delete(`/api/members/${removeTarget.id}`);
      toast.success(data.message || t('members.deleted'));
      closeRemoveDialog();
      fetchMembers();
    } catch (error) {
      // The server explains what is in the way; show that rather than
      // replacing it with something vague.
      setRemoveError(
        error.response?.data?.error || t('members.deleteFailed')
      );
      // History may have appeared since the list loaded, so refresh the flags.
      fetchMembers();
    } finally {
      setRemoveBusy(false);
    }
  };

  const handleSetStatus = async (member, status) => {
    try {
      const { data } = await axios.patch(`/api/members/${member.id}/status`, { status });
      toast.success(data.message || t('members.updated'));
      closeRemoveDialog();
      fetchMembers();
    } catch (error) {
      setRemoveError(error.response?.data?.error || t('members.updateFailed'));
    }
  };

  const handleEdit = (member) => {
    setEditingMember(member);
    setForm({
      full_name: member.full_name,
      email: member.email || '',
      phone: member.phone,
      id_number: member.id_number || '',
      password: '',
      emergency_contact_name: member.emergency_contact_name || '',
      emergency_contact_phone: member.emergency_contact_phone || ''
    });
    setShowModal(true);
  };

  const resetForm = () => {
    setForm({
      full_name: '',
      email: '',
      phone: '',
      id_number: '',
      password: '',
      emergency_contact_name: '',
      emergency_contact_phone: ''
    });
    setEditingMember(null);
  };

  const filteredMembers = members.filter(m =>
    m.full_name.toLowerCase().includes(search.toLowerCase()) ||
    m.phone.includes(search)
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>{t('members.title')}</h1>
        <button className="btn btn-primary" onClick={() => { resetForm(); setShowModal(true); }}>
          <Plus size={18} /> {t('members.add')}
        </button>
      </div>

      <div className="card">
        <div style={{ marginBottom: 16, display: 'flex', gap: 12 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={18} style={{ position: 'absolute', left: 12, top: 12, color: '#999' }} />
            <input
              type="text"
              placeholder={t('members.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ paddingLeft: 40 }}
            />
          </div>
        </div>

        {loading ? (
          <p>{t('common.loading')}</p>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('common.phone')}</th>
                  <th>{t('common.email')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('members.joined')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredMembers.map((member) => (
                  <tr key={member.id}>
                    <td>{member.full_name}</td>
                    <td>{member.phone}</td>
                    <td>{member.email || '-'}</td>
                    <td>
                      <span className={`badge badge-${member.status === 'active' ? 'success' : 'warning'}`}>
                        {member.status === 'active' ? t('status.active') : t('status.inactive')}
                      </span>
                    </td>
                    <td>{new Date(member.joined_date).toLocaleDateString()}</td>
                    <td>
                    <button className="btn btn-sm btn-secondary" onClick={() => handleEdit(member)}>
                      <Edit size={14} />
                    </button>
                    {/*
                      One button, but it means different things. Deleting is
                      impossible once there is financial history, so the icon
                      becomes "deactivate/reactivate" and carries a tooltip
                      saying which.
                    */}
                    <button
                      className={`btn btn-sm ${member.can_delete ? 'btn-danger' : 'btn-secondary'}`}
                      style={{ marginLeft: 8 }}
                      onClick={() => openRemoveDialog(member)}
                      title={
                        member.can_delete
                          ? t('members.deleteConfirm')
                          : t('members.cannotDeleteHint', {
                              what: describeHistory(member.history_blockers)
                            })
                      }
                    >
                      {member.can_delete ? (
                        <Trash2 size={14} />
                      ) : member.status === 'active' ? (
                        <UserX size={14} />
                      ) : (
                        <UserCheck size={14} />
                      )}
                    </button>
                  </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {removeTarget && (() => {
        const blocked = removeTarget.can_delete === false;
        const inactive = removeTarget.status !== 'active';
        return (
          <div className="modal-overlay" onClick={closeRemoveDialog}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
              <div className="modal-header">
                <h2>
                  {blocked
                    ? inactive ? t('members.reactivate') : t('members.cannotDelete')
                    : t('members.deleteConfirm')}
                </h2>
                <button className="modal-close" onClick={closeRemoveDialog}>&times;</button>
              </div>

              <div className="modal-body">
                {blocked ? (
                  <>
                    <div className="notice-strip" style={{ marginBottom: 14 }}>
                      <ShieldAlert size={16} />
                      <span>
                        <strong>{removeTarget.full_name}</strong>{' '}
                        {t('members.hasHistory', {
                          what: describeHistory(removeTarget.history_blockers)
                        })}
                      </span>
                    </div>
                    <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-soft)' }}>
                      {inactive
                        ? t('members.reactivateInstead')
                        : t('members.deactivateInstead')}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="notice-strip notice-strip--danger" style={{ marginBottom: 14 }}>
                      <AlertTriangle size={16} />
                      <span>
                        <strong>{removeTarget.full_name}</strong> {t('members.noHistory')}
                      </span>
                    </div>
                    <p style={{ fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-soft)' }}>
                      {t('members.deletePermanentlyNote')}
                    </p>
                  </>
                )}

                {removeError && (
                  <div className="notice-strip notice-strip--danger" style={{ marginTop: 14 }}>
                    <AlertTriangle size={16} />
                    <span>{removeError}</span>
                  </div>
                )}
              </div>

              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={closeRemoveDialog} disabled={removeBusy}>
                  {t('common.cancel')}
                </button>

                {blocked ? (
                  inactive ? (
                    <button
                      className="btn btn-primary"
                      disabled={removeBusy}
                      onClick={() => handleSetStatus(removeTarget, 'active')}
                    >
                      <UserCheck size={15} /> {t('members.reactivate')}
                    </button>
                  ) : (
                    <button
                      className="btn btn-primary"
                      disabled={removeBusy}
                      onClick={() => handleSetStatus(removeTarget, 'inactive')}
                    >
                      <UserX size={15} /> {t('members.deactivate')}
                    </button>
                  )
                ) : (
                  <button className="btn btn-danger" disabled={removeBusy} onClick={handleDelete}>
                    <Trash2 size={15} />
                    {removeBusy ? t('members.deleting') : t('members.deletePermanently')}
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editingMember ? t('members.edit') : t('members.addNew')}</h2>
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
                <label>{t('common.phone')} *</label>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('common.email')}</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>{t('members.idNumber')}</label>
                <input
                  type="text"
                  value={form.id_number}
                  onChange={(e) => setForm({ ...form, id_number: e.target.value })}
                />
              </div>
              {!editingMember && (
                <div className="form-group">
                  <label>{t('common.password')} *</label>
                  <input
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required={!editingMember}
                  />
                </div>
              )}
              <div className="form-group">
                <label>{t('members.emergencyContactName')}</label>
                <input
                  type="text"
                  value={form.emergency_contact_name}
                  onChange={(e) => setForm({ ...form, emergency_contact_name: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>{t('members.emergencyContactPhone')}</label>
                <input
                  type="tel"
                  value={form.emergency_contact_phone}
                  onChange={(e) => setForm({ ...form, emergency_contact_phone: e.target.value })}
                />
              </div>
              <button type="submit" className="btn btn-primary">
                {editingMember ? t('members.update') : t('members.add')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Members;
