import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Plus, CheckCircle, XCircle, Heart } from 'lucide-react';
import { useFormat } from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';

// Welfare statuses arrive from the API as raw words.
const STATUS_KEY = {
  pending: 'status.pending',
  approved: 'status.approved',
  rejected: 'status.rejected',
  confirmed: 'status.confirmed'
};

const Welfare = () => {
  const { t } = useI18n();
  const { money, opts: fmt } = useFormat();
  const currencyCode = fmt.currency || 'KES';
  const [contributions, setContributions] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [activeTab, setActiveTab] = useState('contributions');
  const [form, setForm] = useState({
    amount: '',
    reason: ''
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [contribRes, requestsRes] = await Promise.all([
        axios.get('/api/welfare/contributions'),
        axios.get('/api/welfare/requests')
      ]);
      setContributions(contribRes.data.contributions);
      setRequests(requestsRes.data.requests);
    } catch (error) {
      toast.error(t('welfare.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitRequest = async (e) => {
    e.preventDefault();
    try {
      await axios.post('/api/welfare/requests', form);
      toast.success(t('welfare.requestSubmitted'));
      setShowModal(false);
      fetchData();
    } catch (error) {
      toast.error(t('welfare.submitFailed'));
    }
  };

  const handleApprove = async (id) => {
    try {
      await axios.post(`/api/welfare/requests/${id}/approve`);
      toast.success(t('welfare.requestApproved'));
      fetchData();
    } catch (error) {
      toast.error(t('welfare.approveFailed'));
    }
  };

  const handleReject = async (id) => {
    try {
      await axios.post(`/api/welfare/requests/${id}/reject`);
      toast.success(t('welfare.requestRejected'));
      fetchData();
    } catch (error) {
      toast.error(t('welfare.rejectFailed'));
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>{t('welfare.title')}</h1>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <Plus size={18} /> {t('welfare.request')}
        </button>
      </div>

      <div className="login-tabs" style={{ marginBottom: 20 }}>
        <div
          className={`login-tab ${activeTab === 'contributions' ? 'active' : ''}`}
          onClick={() => setActiveTab('contributions')}
        >
          {t('welfare.contributions')}
        </div>
        <div
          className={`login-tab ${activeTab === 'requests' ? 'active' : ''}`}
          onClick={() => setActiveTab('requests')}
        >
          {t('welfare.requests')}
        </div>
      </div>

      <div className="card">
        {loading ? (
          <p>{t('common.loading')}</p>
        ) : activeTab === 'contributions' ? (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('contrib.member')}</th>
                  <th>{t('common.amount')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('common.method')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {contributions.map((c) => (
                  <tr key={c.id}>
                    <td>{c.member_name}</td>
                    <td>{money(c.amount)}</td>
                    <td>{new Date(c.contribution_date).toLocaleDateString()}</td>
                    <td>{c.payment_method}</td>
                    <td>
                      <span className={`badge badge-${c.status === 'confirmed' ? 'success' : 'warning'}`}>
                        {STATUS_KEY[c.status] ? t(STATUS_KEY[c.status]) : c.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('contrib.member')}</th>
                  <th>{t('common.amount')}</th>
                  <th>{t('common.reason')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('common.status')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {requests.map((r) => (
                  <tr key={r.id}>
                    <td>{r.member_name}</td>
                    <td>{money(r.amount)}</td>
                    <td>{r.reason}</td>
                    <td>{new Date(r.request_date).toLocaleDateString()}</td>
                    <td>
                      <span className={`badge badge-${r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'danger' : 'warning'}`}>
                        {STATUS_KEY[r.status] ? t(STATUS_KEY[r.status]) : r.status}
                      </span>
                    </td>
                    <td>
                      {r.status === 'pending' && (
                        <>
                          <button className="btn btn-sm btn-primary" onClick={() => handleApprove(r.id)}>
                            <CheckCircle size={14} />
                          </button>
                          <button className="btn btn-sm btn-danger" onClick={() => handleReject(r.id)} style={{ marginLeft: 8 }}>
                            <XCircle size={14} />
                          </button>
                        </>
                      )}
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
              <h2>{t('welfare.requestAssistance')}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleSubmitRequest}>
              <div className="form-group">
                <label>{t('welfare.amountNeeded', { currency: form.currency || currencyCode })}</label>
                <input
                  type="number"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('welfare.reasonForRequest')}</label>
                <textarea
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  rows={4}
                  placeholder={t('welfare.reasonPlaceholder')}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary">
                <Heart size={18} /> {t('welfare.submitRequest')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Welfare;
