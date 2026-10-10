import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Plus, Smartphone } from 'lucide-react';
import { useFormat } from '../context/FormatContext';
import { usePaymentGateways } from '../hooks/usePaymentGateways';
import { useI18n } from '../i18n/I18nContext';

// Status values arrive from the API as raw words; map the ones this table can
// show to shared status labels and fall back to the raw value if unknown.
const STATUS_KEY = { confirmed: 'status.confirmed', pending: 'status.pending' };

const Contributions = () => {
  const { t } = useI18n();
  const { money, opts: fmt } = useFormat();
  const currencyCode = fmt.currency || 'KES';
  const [contributions, setContributions] = useState([]);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showMpesaModal, setShowMpesaModal] = useState(false);
  const [sendingMpesa, setSendingMpesa] = useState(false);
  const { options: paymentMethods, loading: methodsLoading, pickDefault } = usePaymentGateways();

  // Keep the chosen method valid: switching a gateway off in Settings must not
  // leave this select holding a value that is no longer among its options.
  useEffect(() => {
    if (methodsLoading) return;
    setForm((f) => ({ ...f, payment_method: pickDefault(f.payment_method) }));
  }, [paymentMethods, methodsLoading, pickDefault]);

  const [form, setForm] = useState({
    member_id: '',
    amount: '',
    contribution_date: new Date().toISOString().split('T')[0],
    payment_method: 'cash',
    reference_number: '',
    remarks: ''
  });
  const [mpesaForm, setMpesaForm] = useState({
    phone: '',
    amount: '',
    reference: ''
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [contribRes, membersRes] = await Promise.all([
        axios.get('/api/contributions'),
        axios.get('/api/members')
      ]);
      setContributions(contribRes.data.contributions);
      setMembers(membersRes.data.members);
    } catch (error) {
      toast.error(t('err.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await axios.post('/api/contributions', form);
      toast.success(t('contrib.recorded'));
      setShowModal(false);
      fetchData();
    } catch (error) {
      toast.error(error.response?.data?.error || t('contrib.recordFailed'));
    }
  };

  const handleMpesaPayment = async (e) => {
    e.preventDefault();
    setSendingMpesa(true);
    try {
      const response = await axios.post('/api/mpesa/stk-push', mpesaForm);
      toast.success(response.data.message || t('contrib.promptSent'));
      // The prompt can succeed while confirmations cannot be delivered. Saying so
      // beats a transaction silently sitting on "pending" forever.
      if (response.data.warning) {
        toast(response.data.warning, { duration: 15000, icon: '⚠' });
      }
      setShowMpesaModal(false);
    } catch (error) {
      const data = error.response?.data || {};

      // Daraja rejections carry a machine code and, usually, a specific fix.
      // Showing only "failed" left the operator with nothing to act on, so the
      // code and the hint are surfaced too.
      const parts = [];
      if (data.daraja_code) parts.push(t('contrib.safaricomCode', { code: data.daraja_code }));
      parts.push(data.error || t('contrib.safaricomUnreachable'));

      toast.error(parts.join(' - '), { duration: 9000 });

      if (data.hint) {
        toast(data.hint, { duration: 14000, icon: '⚙' });
      } else if (data.daraja_message) {
        toast(t('contrib.darajaSaid', { message: data.daraja_message }), { duration: 9000 });
      }
    } finally {
      setSendingMpesa(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>{t('contrib.title')}</h1>
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="btn btn-primary" onClick={() => setShowMpesaModal(true)}>
            <Smartphone size={18} /> {t('contrib.mpesaPayment')}
          </button>
          <button className="btn btn-secondary" onClick={() => setShowModal(true)}>
            <Plus size={18} /> {t('contrib.recordCash')}
          </button>
        </div>
      </div>

      <div className="card">
        {loading ? (
          <p>{t('common.loading')}</p>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('contrib.member')}</th>
                  <th>{t('common.amount')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('common.method')}</th>
                  <th>{t('common.reference')}</th>
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
                    <td>{c.reference_number || '-'}</td>
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
        )}
      </div>

      {/* Record Cash Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('contrib.record')}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label>{t('contrib.member')} *</label>
                <select
                  value={form.member_id}
                  onChange={(e) => setForm({ ...form, member_id: e.target.value })}
                  required
                >
                  <option value="">{t('contrib.selectMember')}</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>{m.full_name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>{t('contrib.amountLabel', { currency: form.currency || currencyCode })}</label>
                <input
                  type="number"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('contrib.date')} *</label>
                <input
                  type="date"
                  value={form.contribution_date}
                  onChange={(e) => setForm({ ...form, contribution_date: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('contrib.paymentMethod')}</label>
                <select
                  value={form.payment_method}
                  onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
                >
                  {paymentMethods.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>{t('contrib.referenceNumber')}</label>
                <input
                  type="text"
                  value={form.reference_number}
                  onChange={(e) => setForm({ ...form, reference_number: e.target.value })}
                />
              </div>
              <div className="form-group">
                <label>{t('common.notes')}</label>
                <textarea
                  value={form.remarks}
                  onChange={(e) => setForm({ ...form, remarks: e.target.value })}
                  rows={3}
                />
              </div>
              <button type="submit" className="btn btn-primary">{t('contrib.record')}</button>
            </form>
          </div>
        </div>
      )}

      {/* M-Pesa Modal */}
      {showMpesaModal && (
        <div className="modal-overlay" onClick={() => setShowMpesaModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('contrib.stkPush')}</h2>
              <button className="modal-close" onClick={() => setShowMpesaModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleMpesaPayment}>
              <div className="form-group">
                <label>{t('auth.phone')} *</label>
                <input
                  type="tel"
                  value={mpesaForm.phone}
                  onChange={(e) => setMpesaForm({ ...mpesaForm, phone: e.target.value })}
                  placeholder="0712345678"
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('contrib.amountLabel', { currency: form.currency || currencyCode })}</label>
                <input
                  type="number"
                  value={mpesaForm.amount}
                  onChange={(e) => setMpesaForm({ ...mpesaForm, amount: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('common.reference')}</label>
                <input
                  type="text"
                  value={mpesaForm.reference}
                  onChange={(e) => setMpesaForm({ ...mpesaForm, reference: e.target.value })}
                  placeholder={t('contrib.referencePlaceholder')}
                />
              </div>
              <button type="submit" className="btn btn-primary" disabled={sendingMpesa}>
                <Smartphone size={18} />
                {sendingMpesa ? t('contrib.waitingSafaricom') : t('contrib.sendPrompt')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Contributions;
