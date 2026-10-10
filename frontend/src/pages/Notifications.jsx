import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Send, MessageSquare, Mail, Phone } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';

// The API stores notification types and categories as enum values, which must go
// back to the server unchanged. Only the words an admin reads are translated.
const TYPE_LABELS = { in_app: 'notif.inApp' };
const CATEGORY_LABELS = {
  general: 'notif.categoryGeneral',
  payment: 'notif.categoryPayment',
  loan: 'notif.categoryLoan',
  welfare: 'notif.categoryWelfare',
  reminder: 'notif.categoryReminder'
};

const Notifications = () => {
  const { t } = useI18n();
  const [notifications, setNotifications] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({
    member_id: '',
    type: 'sms',
    category: 'general',
    subject: '',
    message: ''
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [notifRes, membersRes] = await Promise.all([
        axios.get('/api/notifications'),
        axios.get('/api/members')
      ]);
      setNotifications(notifRes.data.notifications);
      setMembers(membersRes.data.members);
    } catch (error) {
      toast.error(t('notif.fetchFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    try {
      await axios.post('/api/notifications/send', form);
      toast.success(t('notif.sentSuccessfully'));
      setShowModal(false);
      fetchData();
    } catch (error) {
      toast.error(t('notif.sendFailed'));
    }
  };

  const getTypeIcon = (type) => {
    switch (type) {
      case 'sms': return <Phone size={14} />;
      case 'whatsapp': return <MessageSquare size={14} />;
      case 'email': return <Mail size={14} />;
      default: return <MessageSquare size={14} />;
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>{t('notif.title')}</h1>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <Send size={18} /> {t('notif.send')}
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
                  <th>{t('notif.type')}</th>
                  <th>{t('notif.category')}</th>
                  <th>{t('notif.recipient')}</th>
                  <th>{t('notif.message')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.date')}</th>
                </tr>
              </thead>
              <tbody>
                {notifications.map((n) => (
                  <tr key={n.id}>
                    <td>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {getTypeIcon(n.type)}
                        {TYPE_LABELS[n.type] ? t(TYPE_LABELS[n.type]) : n.type}
                      </span>
                    </td>
                    <td>{CATEGORY_LABELS[n.category] ? t(CATEGORY_LABELS[n.category]) : n.category}</td>
                    <td>{n.member_name || n.admin_name || t('common.all')}</td>
                    <td style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {n.message}
                    </td>
                    <td>
                      <span className={`badge badge-${n.status === 'sent' ? 'success' : n.status === 'failed' ? 'danger' : 'warning'}`}>
                        {t(`status.${n.status}`)}
                      </span>
                    </td>
                    <td>{new Date(n.created_at).toLocaleDateString()}</td>
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
              <h2>{t('notif.send')}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleSend}>
              <div className="form-group">
                <label>{t('notif.recipient')} *</label>
                <select
                  value={form.member_id}
                  onChange={(e) => setForm({ ...form, member_id: e.target.value })}
                  required
                >
                  <option value="">{t('contrib.selectMember')}</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.full_name} ({m.phone})</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>{t('notif.type')} *</label>
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                >
                  <option value="sms">SMS</option>
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">{t('common.email')}</option>
                  <option value="in_app">{t('notif.inApp')}</option>
                </select>
              </div>
              <div className="form-group">
                <label>{t('notif.category')}</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                >
                  <option value="general">{t('notif.categoryGeneral')}</option>
                  <option value="payment">{t('notif.categoryPayment')}</option>
                  <option value="loan">{t('notif.categoryLoan')}</option>
                  <option value="welfare">{t('notif.categoryWelfare')}</option>
                  <option value="reminder">{t('notif.categoryReminder')}</option>
                </select>
              </div>
              <div className="form-group">
                <label>{t('notif.subject')}</label>
                <input
                  type="text"
                  value={form.subject}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>{t('notif.message')} *</label>
                <textarea
                  value={form.message}
                  onChange={(e) => setForm({ ...form, message: e.target.value })}
                  rows={4}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary">
                <Send size={18} /> {t('notif.send')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Notifications;
