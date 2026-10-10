import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import {
  UserCheck,
  UserX,
  Inbox,
  CheckCircle,
  XCircle,
  RefreshCw,
  Clock,
  ShieldCheck,
  Phone,
  Mail,
  Contact
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

const Registrations = () => {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/members/registrations');
      setData(res.data);
    } catch (error) {
      toast.error(error.response?.data?.error || t('reg.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const approve = async (member) => {
    setBusyId(member.id);
    try {
      const res = await axios.post(`/api/members/registrations/${member.id}/approve`);
      toast.success(res.data.message);
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || t('reg.approveFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (e) => {
    e.preventDefault();
    if (!reason.trim()) {
      toast.error(t('reg.reasonRequired'));
      return;
    }
    setBusyId(rejecting.id);
    try {
      const res = await axios.post(`/api/members/registrations/${rejecting.id}/reject`, {
        reason
      });
      toast.success(res.data.message);
      setRejecting(null);
      setReason('');
      load();
    } catch (error) {
      toast.error(error.response?.data?.error || t('reg.rejectFailed'));
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="card">
        <div className="empty-state">
          <Inbox size={36} />
          <p>{t('reg.loadingApplications')}</p>
        </div>
      </div>
    );
  }

  const { pending, recently_rejected: rejected, counts } = data;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('reg.pageTitle')}</h1>
          <p className="page-sub">{t('reg.subtitle')}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={load}>
            <RefreshCw size={16} /> {t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card stat-card--light" style={{ borderLeftColor: '#f59e0b' }}>
          <div className="stat-top">
            <div>
              <div className="stat-label">{t('reg.waiting')}</div>
              <div className="stat-value">{counts.pending || 0}</div>
              <div className="stat-hint">{t('reg.needDecision')}</div>
            </div>
            <div className="stat-icon"><Clock size={22} /></div>
          </div>
        </div>
        <div className="stat-card stat-card--light" style={{ borderLeftColor: '#16a34a' }}>
          <div className="stat-top">
            <div>
              <div className="stat-label">{t('reg.activeMembers')}</div>
              <div className="stat-value">{counts.active || 0}</div>
              <div className="stat-hint">{t('reg.canLogIn')}</div>
            </div>
            <div className="stat-icon"><UserCheck size={22} /></div>
          </div>
        </div>
        <div className="stat-card stat-card--light" style={{ borderLeftColor: '#dc2626' }}>
          <div className="stat-top">
            <div>
              <div className="stat-label">{t('reg.declined')}</div>
              <div className="stat-value">{counts.rejected || 0}</div>
              <div className="stat-hint">{t('reg.allTime')}</div>
            </div>
            <div className="stat-icon"><UserX size={22} /></div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Inbox size={18} /> {t('reg.pendingApplications')}
          </h3>
          {pending.length > 0 && (
            <span className="badge badge-warning">{t('reg.waitingCount', { n: pending.length })}</span>
          )}
        </div>

        {pending.length === 0 ? (
          <div className="empty-state">
            <CheckCircle size={40} style={{ color: '#16a34a' }} />
            <p style={{ fontWeight: 600, color: '#0f172a' }}>{t('reg.noApplications')}</p>
            <p style={{ fontSize: 13 }}>{t('reg.newSignupsNote')}</p>
          </div>
        ) : (
          <div className="registration-list">
            {pending.map((m) => (
              <div key={m.id} className="registration-item">
                <div className="registration-avatar">
                  {(m.full_name || '?')
                    .split(' ')
                    .map((n) => n[0])
                    .slice(0, 2)
                    .join('')}
                </div>

                <div className="registration-main">
                  <div className="registration-name">{m.full_name}</div>
                  <div className="registration-meta">
                    <span><Phone size={12} /> {m.phone}</span>
                    {m.email && <span><Mail size={12} /> {m.email}</span>}
                    {m.id_number && <span><Contact size={12} /> {m.id_number}</span>}
                    <span><Clock size={12} /> {t('reg.appliedOn')} {new Date(m.created_at).toLocaleDateString()}</span>
                  </div>
                  {m.emergency_contact_name && (
                    <div className="registration-emergency">
                      {t('reg.emergencyPrefix')}: {m.emergency_contact_name}
                      {m.emergency_contact_phone ? ` · ${m.emergency_contact_phone}` : ''}
                    </div>
                  )}
                </div>

                <div className="registration-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => approve(m)}
                    disabled={busyId === m.id}
                  >
                    <UserCheck size={15} /> {t('reg.approve')}
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => setRejecting(m)}
                    disabled={busyId === m.id}
                  >
                    <XCircle size={15} /> {t('reg.reject')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <XCircle size={18} /> {t('reg.recentlyDeclined')}
          </h3>
        </div>

        {rejected.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: 14 }}>{t('reg.noDeclined')}</p>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('common.name')}</th>
                  <th>{t('common.phone')}</th>
                  <th>{t('common.reason')}</th>
                  <th>{t('reg.declined')}</th>
                </tr>
              </thead>
              <tbody>
                {rejected.map((m) => (
                  <tr key={m.id}>
                    <td style={{ fontWeight: 600 }}>{m.full_name}</td>
                    <td>{m.phone}</td>
                    <td style={{ color: '#b91c1c', fontSize: 13 }}>{m.rejection_reason}</td>
                    <td style={{ fontSize: 13 }}>
                      {m.reviewed_at ? new Date(m.reviewed_at).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {rejecting && (
        <div className="modal-overlay" onClick={() => setRejecting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('reg.declineTitle', { name: rejecting.full_name })}</h2>
              <button className="modal-close" onClick={() => setRejecting(null)}>
                &times;
              </button>
            </div>

            <div className="notice-strip notice-strip--danger">
              <ShieldCheck size={16} />
              <span>{t('reg.declineWarning', { name: rejecting.full_name })}</span>
            </div>

            <form onSubmit={reject}>
              <div className="form-group">
                <label>{t('reg.rejectReason')} *</label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder={t('reg.reasonPlaceholder')}
                  required
                />
              </div>
              <button
                type="submit"
                className="btn btn-danger btn-block"
                disabled={busyId === rejecting.id}
              >
                {busyId === rejecting.id ? t('common.saving') : t('reg.declineApplication')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Registrations;