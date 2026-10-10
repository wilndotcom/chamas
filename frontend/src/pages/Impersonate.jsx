import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { Eye, Users, Shield, UserCheck } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

const Impersonate = () => {
  const { user, impersonate, isSuperAdmin } = useAuth();
  const { t } = useI18n();
  const [targets, setTargets] = useState({ members: [], admins: [] });
  const [memberId, setMemberId] = useState('');
  const [adminId, setAdminId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isSuperAdmin) {
      setLoading(false);
      return;
    }
    fetchTargets();
  }, [isSuperAdmin]);

  const fetchTargets = async () => {
    try {
      const { data } = await axios.get('/api/auth/impersonation-targets');
      setTargets(data);
    } catch (error) {
      toast.error(error.response?.data?.error || t('portal.loadAccountsFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleImpersonate = async (type, id) => {
    if (!id) {
      toast.error(t('portal.selectAccountFirst'));
      return;
    }
    setBusy(true);
    try {
      await impersonate(type, Number(id));
      toast.success(t('portal.openedHint'));
    } catch (error) {
      toast.error(error.response?.data?.error || t('portal.openFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (!isSuperAdmin) {
    return (
      <div className="card">
        <h1 style={{ fontSize: 28, fontWeight: 700, marginBottom: 12 }}>{t('portal.title')}</h1>
        <p style={{ color: '#666' }}>{t('portal.superOnly')}</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>{t('portal.title')}</h1>
      </div>
      <p style={{ color: '#666', marginBottom: 24 }}>{t('portal.description')}</p>

      <div className="impersonation-note">
        <Shield size={18} />
        <div>
          <strong>{t('portal.auditTitle')}</strong>
          <span>
            {t('portal.auditNote')} (<code>allow_impersonation</code>)
          </span>
        </div>
      </div>

      {loading ? (
        <p>{t('portal.loadingAccounts')}</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div className="card">
            <div className="card-header">
              <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Users size={18} /> {t('portal.viewAsMember')}
              </h3>
            </div>
            <p style={{ color: '#666', fontSize: 14, marginBottom: 16 }}>
              {t('portal.memberDescription')}
            </p>
            <div className="form-group">
              <label>{t('portal.selectMember')}</label>
              <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="">{t('portal.chooseMember')}</option>
                {targets.members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.full_name} — {m.phone}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="btn btn-primary"
              onClick={() => handleImpersonate('member', memberId)}
              disabled={busy || !memberId}
            >
              <Eye size={18} /> {t('portal.openMemberPortal')}
            </button>
          </div>

          <div className="card">
            <div className="card-header">
              <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <UserCheck size={18} /> {t('portal.viewAsAdmin')}
              </h3>
            </div>
            <p style={{ color: '#666', fontSize: 14, marginBottom: 16 }}>
              {t('portal.adminDescription')}
            </p>
            <div className="form-group">
              <label>{t('portal.selectAdmin')}</label>
              <select value={adminId} onChange={(e) => setAdminId(e.target.value)}>
                <option value="">{t('portal.chooseAdmin')}</option>
                {targets.admins.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.full_name} — {a.role_name}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="btn btn-primary"
              onClick={() => handleImpersonate('admin', adminId)}
              disabled={busy || !adminId}
            >
              <Eye size={18} /> {t('portal.openAdminPortal')}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <h3 className="card-title" style={{ marginBottom: 12 }}>{t('portal.goodToKnow')}</h3>
        <ul style={{ color: '#555', lineHeight: 1.9, paddingLeft: 20, fontSize: 14 }}>
          <li>{t('portal.note1')}</li>
          <li>{t('portal.note2')}</li>
          <li>{t('portal.note3')}</li>
          <li>{t('portal.note4')}</li>
        </ul>
      </div>
    </div>
  );
};

export default Impersonate;