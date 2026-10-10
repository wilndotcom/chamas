import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Plus, CheckCircle, XCircle, DollarSign, Percent, CalendarClock, Wallet } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useFormat } from '../context/FormatContext';
import { usePaymentGateways } from '../hooks/usePaymentGateways';
import { useI18n } from '../i18n/I18nContext';

// Loan statuses arrive from the API as raw words; map them to shared labels and
// fall back to the raw value if the backend ever adds a new one.
const STATUS_KEY = {
  pending: 'status.pending',
  approved: 'status.approved',
  active: 'status.active',
  disbursed: 'status.disbursed',
  completed: 'status.completed',
  defaulted: 'status.defaulted',
  rejected: 'status.rejected'
};

const Loans = () => {
  const { t } = useI18n();
  const { user } = useAuth();
  const isMember = user?.type === 'member';
  const { money, opts: fmt } = useFormat();
  // Payment methods come from the gateway registry, so a gateway switched off in
  // Settings disappears here automatically.
  const { options: paymentMethods, loading: methodsLoading, pickDefault } = usePaymentGateways();
  const currencyCode = fmt.currency || 'KES';
  const [loans, setLoans] = useState([]);
  const [loanSummary, setLoanSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [showRepayModal, setShowRepayModal] = useState(false);
  const [selectedLoan, setSelectedLoan] = useState(null);
  const [form, setForm] = useState({
    principal_amount: '',
    purpose: ''
  });
  const [repayForm, setRepayForm] = useState({
    amount: '',
    payment_method: 'cash',
    reference_number: ''
  });
  // Terms agreed at approval. Seeded from the loan's own snapshotted rate so the
  // member keeps the price they applied at.
  const [approveForm, setApproveForm] = useState({
    interest_rate: '',
    duration_months: ''
  });
  const [approving, setApproving] = useState(false);
  const [showApproveModal, setShowApproveModal] = useState(false);
  // Member self-service repayment
  const [showPayModal, setShowPayModal] = useState(false);
  const [payLoan, setPayLoan] = useState(null);
  const [payForm, setPayForm] = useState({
    amount: '',
    payment_method: 'mpesa_c2b',
    reference_number: ''
  });
  const [paying, setPaying] = useState(false);

  useEffect(() => {
    fetchLoans();
  }, []);

  // A gateway switched off in Settings must not leave a form holding a method
  // that is no longer in its own dropdown. pickDefault leaves a still-valid
  // selection alone, so this never overrides a choice the user just made.
  useEffect(() => {
    if (methodsLoading) return;
    setRepayForm((f) => ({ ...f, payment_method: pickDefault(f.payment_method) }));
    setPayForm((f) => ({ ...f, payment_method: pickDefault(f.payment_method) }));
  }, [paymentMethods, methodsLoading, pickDefault]);

  const fetchLoans = async () => {
    try {
      // Members may only read their own loans, so they use a different endpoint.
      const response = await axios.get(isMember ? '/api/loans/mine' : '/api/loans');
      setLoans(response.data.loans);
      if (isMember) setLoanSummary(response.data.summary || null);
    } catch (error) {
      toast.error(error.response?.data?.error || t('err.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleApply = async (e) => {
    e.preventDefault();
    try {
      await axios.post('/api/loans/apply', form);
      toast.success(t('loans.applicationSubmitted'));
      setShowModal(false);
      fetchLoans();
    } catch (error) {
      toast.error(error.response?.data?.error || t('loans.applyFailed'));
    }
  };

  // Opens the approval dialog with the rate already agreed at application time.
  const openApprove = (loan) => {
    setSelectedLoan(loan);
    setApproveForm({
      interest_rate: String(loan.interest_rate ?? ''),
      duration_months: ''
    });
    setShowApproveModal(true);
  };

  const handleApprove = async (e) => {
    e.preventDefault();
    if (!selectedLoan) return;
    setApproving(true);
    try {
      // Blank duration means "use the chama's configured default".
      const payload = { interest_rate: Number(approveForm.interest_rate) };
      if (approveForm.duration_months !== '') {
        payload.duration_months = Number(approveForm.duration_months);
      }
      const res = await axios.post(`/api/loans/${selectedLoan.id}/approve`, payload);
      toast.success(
        t('loans.approvedSummary', {
          rate: res.data.interest_rate,
          amount: money(res.data.total_repayable)
        })
      );
      setShowApproveModal(false);
      setSelectedLoan(null);
      fetchLoans();
    } catch (error) {
      toast.error(error.response?.data?.error || t('loans.approveFailed'));
    } finally {
      setApproving(false);
    }
  };

  const handleDisburse = async (id) => {
    try {
      await axios.post(`/api/loans/${id}/disburse`, {});
      toast.success(t('loans.disbursed'));
      fetchLoans();
    } catch (error) {
      toast.error(t('loans.disburseFailed'));
    }
  };

  const handleRepay = async (e) => {
    e.preventDefault();
    try {
      await axios.post('/api/loans/repayment', {
        loan_id: selectedLoan.id,
        ...repayForm
      });
      toast.success(t('loans.paymentRecorded'));
      setShowRepayModal(false);
      fetchLoans();
    } catch (error) {
      toast.error(t('loans.repayFailed'));
    }
  };

  /** Opens the member's repay dialog, seeded for a full payment. */
  const openPay = (loan) => {
    setPayLoan(loan);
    setPayForm({
      amount: String(Number(loan.balance).toFixed(2)),
      payment_method: pickDefault('mpesa_c2b'),
      reference_number: ''
    });
    setShowPayModal(true);
  };

  /**
   * Member pays their own loan.
   *
   * The server rejects anything above the balance, so the client-side cap is
   * only there to explain the limit before the round trip.
   */
  const handlePay = async (e) => {
    e.preventDefault();
    if (!payLoan) return;

    const amount = Number(payForm.amount);
    const balance = Number(payLoan.balance);

    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error(t('loans.enterPositiveAmount'));
      return;
    }
    if (amount > balance) {
      toast.error(t('loans.maxPayable', { amount: money(balance) }));
      return;
    }

    setPaying(true);
    try {
      const res = await axios.post(`/api/loans/${payLoan.id}/pay`, {
        amount,
        payment_method: payForm.payment_method,
        reference_number: payForm.reference_number
      });

      toast.success(res.data.message, { duration: 6000 });
      setShowPayModal(false);
      setPayLoan(null);
      fetchLoans();
    } catch (error) {
      toast.error(error.response?.data?.error || t('loans.payFailed'));
    } finally {
      setPaying(false);
    }
  };

const getStatusBadge = (status) => {
    const colors = {
      pending: 'warning',
      approved: 'info',
      active: 'success',
      completed: 'success',
      defaulted: 'danger',
      rejected: 'danger'
    };
    return (
      <span className={`badge badge-${colors[status] || 'info'}`}>
        {STATUS_KEY[status] ? t(STATUS_KEY[status]) : status}
      </span>
    );
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>{isMember ? t('loans.myLoans') : t('loans.title')}</h1>
        {isMember && (
          <button className="btn btn-primary" onClick={() => setShowModal(true)}>
            <Plus size={18} /> {t('loans.apply')}
          </button>
        )}
      </div>

      {isMember && loanSummary && loanSummary.open_loan_count > 0 && (
        <div className="owe-hero" style={{ marginBottom: 20 }}>
          <div className="owe-hero-total">
            <span>{t('loans.totalOutstanding')}</span>
            <strong>{money(loanSummary.total_balance)}</strong>
            <em>
              {loanSummary.open_loan_count === 1
                ? t('loans.acrossOneLoan')
                : t('loans.acrossLoans', { n: loanSummary.open_loan_count })}
            </em>
          </div>
          <div className="owe-split">
            <div className="owe-split-row">
              <span className="owe-dot" style={{ background: '#2563eb' }} />
              <span className="owe-split-label">{t('loans.principalToPay')}</span>
              <strong>{money(loanSummary.principal_outstanding)}</strong>
            </div>
            <div className="owe-split-row">
              <span className="owe-dot" style={{ background: '#f97316' }} />
              <span className="owe-split-label">{t('loans.interestToPay')}</span>
              <strong style={{ color: '#c2410c' }}>
                {money(loanSummary.interest_outstanding)}
              </strong>
            </div>
            <div className="owe-split-row owe-split-total">
              <span />
              <span className="owe-split-label">{t('loans.totalToClear')}</span>
              <strong>{money(loanSummary.total_balance)}</strong>
            </div>
            {/* Jump straight to repayment instead of hunting for the row. */}
            {loans.some(
              (l) =>
                (l.status === 'active' || l.status === 'disbursed') &&
                Number(l.balance) > 0
            ) && (
              <button
                className="btn btn-primary btn-block"
                style={{ marginTop: 14 }}
                onClick={() => {
                  const target = loans.find(
                    (l) =>
                      (l.status === 'active' || l.status === 'disbursed') &&
                      Number(l.balance) > 0
                  );
                  openPay(target);
                }}
              >
                <Wallet size={17} /> {t('loans.pay')}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="card">
        {loading ? (
          <p>{t('common.loading')}</p>
        ) : loans.length === 0 ? (
          <div className="empty-state">
            <p>{isMember ? t('loans.noLoansMember') : t('loans.noLoansAdmin')}</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  {!isMember && <th>{t('contrib.member')}</th>}
                  <th>{t('loans.principalShort')}</th>
                  <th>{t('loans.interestAmount')}</th>
                  <th>{t('common.total')}</th>
                  <th>{t('loans.balance')}</th>
                  {isMember && <th>{t('loans.interestLeft')}</th>}
                  <th>{t('common.status')}</th>
                  <th>{t('loans.dueDate')}</th>
                  <th>{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {loans.map((loan) => (
                  <tr key={loan.id}>
                    <td>{!isMember && loan.member_name}</td>
                    <td>{money(loan.principal_amount)}</td>
                    <td>{loan.interest_rate}%</td>
                    <td>{money(loan.total_repayable)}</td>
                    <td>{money(Number(loan.balance))}</td>
                    {isMember && (
                      <td style={{ fontWeight: 700, color: '#c2410c' }}>
                        {money(Number(loan.interest_outstanding || 0))}
                      </td>
                    )}
                    <td>{getStatusBadge(loan.status)}</td>
                    <td>{loan.due_date ? new Date(loan.due_date).toLocaleDateString() : '-'}</td>
                    <td>
                      {isMember ? (
                        // A member repays their own loan, in full or in part.
                        (loan.status === 'active' || loan.status === 'disbursed') && Number(loan.balance) > 0 ? (
                          <button
                            className="btn btn-sm btn-primary"
                            onClick={() => openPay(loan)}
                          >
                            <Wallet size={14} /> {t('loans.pay')}
                          </button>
                        ) : (
                          <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>
                            {loan.status === 'completed' ? t('loans.fullyRepaid') : t('loans.notPayableYet')}
                          </span>
                        )
                      ) : (
                        <>
                          {loan.status === 'pending' && (
                            <button className="btn btn-sm btn-primary" onClick={() => openApprove(loan)}>
                              <CheckCircle size={14} /> {t('loans.approve')}
                            </button>
                          )}
                          {loan.status === 'approved' && (
                            <button className="btn btn-sm btn-primary" onClick={() => handleDisburse(loan.id)}>
                              <DollarSign size={14} /> {t('loans.disburse')}
                            </button>
                          )}
                          {(loan.status === 'active' || loan.status === 'disbursed') && (
                            <button
                              className="btn btn-sm btn-secondary"
                              onClick={() => { setSelectedLoan(loan); setShowRepayModal(true); }}
                            >
                              {t('loans.recordPayment')}
                            </button>
                          )}
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

      {/* Apply Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('loans.apply')}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>&times;</button>
            </div>
            <form onSubmit={handleApply}>
              <div className="form-group">
                <label>{t('loans.amountLabel', { currency: form.currency || currencyCode })}</label>
                <input
                  type="number"
                  value={form.principal_amount}
                  onChange={(e) => setForm({ ...form, principal_amount: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('loans.purpose')} *</label>
                <textarea
                  value={form.purpose}
                  onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                  rows={3}
                  required
                />
              </div>
              <button type="submit" className="btn btn-primary">{t('loans.submitApplication')}</button>
            </form>
          </div>
        </div>
      )}

      {/* Approval Modal — shows the flat-interest arithmetic before committing */}
      {showApproveModal && selectedLoan && (() => {
        const principal = Number(selectedLoan.principal_amount) || 0;
        const rate = Number(approveForm.interest_rate);
        const validRate = Number.isFinite(rate) && rate >= 0 && rate <= 100;
        const interest = validRate ? (principal * rate) / 100 : 0;
        const total = principal + interest;
        const months = Number(approveForm.duration_months);
        const duePreview = (() => {
          if (!Number.isFinite(months) || months < 1) return null;
          const d = new Date();
          d.setMonth(d.getMonth() + Math.round(months));
          return d.toLocaleDateString();
        })();

        return (
        <div className="modal-overlay" onClick={() => setShowApproveModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('loans.approveTitle')}</h2>
              <button className="modal-close" onClick={() => setShowApproveModal(false)}>&times;</button>
            </div>

            <p className="approve-member">
              {selectedLoan.member_name}
              {selectedLoan.purpose && <span> &middot; {selectedLoan.purpose}</span>}
            </p>

            <div className="form-row">
              <div className="form-group">
                <label>
                  <Percent size={13} /> {t('loans.interestRateLabel')}
                </label>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={approveForm.interest_rate}
                  onChange={(e) =>
                    setApproveForm({ ...approveForm, interest_rate: e.target.value })
                  }
                  required
                />
              </div>
              <div className="form-group">
                <label>
                  <CalendarClock size={13} /> {t('loans.durationMonths')}
                </label>
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="60"
                  placeholder={t('loans.chamaDefault')}
                  value={approveForm.duration_months}
                  onChange={(e) =>
                    setApproveForm({ ...approveForm, duration_months: e.target.value })
                  }
                />
              </div>
            </div>

            {/* The member repays this figure in full. Flat interest is charged
                once on the principal, never compounded on the balance. */}
            <div className="interest-preview">
              <div className="interest-preview-row">
                <span>{t('loans.amountBorrowed')}</span>
                <strong>{money(principal)}</strong>
              </div>
              <div className="interest-preview-row">
                <span>
                  {t('loans.interestAt', { rate: validRate ? rate : '—' })}
                </span>
                <strong>{validRate ? money(interest) : '—'}</strong>
              </div>
              <div className="interest-preview-row total">
                <span>{t('loans.totalRepayable')}</span>
                <strong>{validRate ? money(total) : '—'}</strong>
              </div>
              {duePreview && (
                <p className="interest-preview-due">{t('loans.dueOn', { date: duePreview })}</p>
              )}
            </div>

            <p className="interest-preview-note">
              {t('loans.flatInterestNote')}
            </p>

            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setShowApproveModal(false)}
                disabled={approving}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                onClick={handleApprove}
                disabled={approving || !validRate}
              >
                <CheckCircle size={16} /> {approving ? t('loans.approving') : t('loans.approveTitle')}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Member Pay Loan — full or partial */}
      {showPayModal && payLoan && (() => {
        const balance = Number(payLoan.balance);
        const entered = Number(payForm.amount);
        const valid =
          Number.isFinite(entered) && entered > 0 && entered <= balance;
        const remaining = valid ? balance - entered : balance;
        const after = Math.max(0, remaining);
        const clears = valid && after === 0;

        // Rounded suggestions that are actually useful on a chama balance.
        const presets = [100, 500, 1000, 2500, 5000]
          .filter((v) => v < balance)
          .slice(0, 4);

        return (
          <div className="modal-overlay" onClick={() => !paying && setShowPayModal(false)}>
            <div className="modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>{t('loans.pay')}</h2>
                <button
                  className="modal-close"
                  onClick={() => setShowPayModal(false)}
                  disabled={paying}
                >
                  &times;
                </button>
              </div>

              <div className="pay-balance">
                <span>{t('loans.balanceOnLoan')}</span>
                <strong>{money(balance)}</strong>
              </div>

              <div className="form-group">
                <label>
                  <Wallet size={13} /> {t('loans.amountToPay', { currency: currencyCode })}
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={balance}
                  value={payForm.amount}
                  onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })}
                  disabled={paying}
                  required
                />
              </div>

              <div className="pay-quick">
                <button
                  type="button"
                  className="btn btn-sm btn-secondary"
                  onClick={() =>
                    setPayForm({ ...payForm, amount: String(balance.toFixed(2)) })
                  }
                  disabled={paying}
                >
                  {t('loans.payFull')}
                </button>
                {presets.map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => setPayForm({ ...payForm, amount: String(v) })}
                    disabled={paying}
                  >
                    {money(v)}
                  </button>
                ))}
              </div>

              {/* Says plainly whether this clears the loan or leaves a tail. */}
              <div className={`pay-result${clears ? ' clears' : ''}`}>
                {entered > balance ? (
                  <span className="pay-result-bad">
                    {t('loans.overBalance', { amount: money(balance) })}
                  </span>
                ) : !valid ? (
                  <span className="pay-result-bad">{t('loans.enterPositiveAmount')}</span>
                ) : clears ? (
                  <>
                    <span>{t('loans.afterThisPayment')}</span>
                    <strong>{t('loans.nothingLeft')}</strong>
                  </>
                ) : (
                  <>
                    <span>{t('loans.leftToPayAfter')}</span>
                    <strong>{money(after)}</strong>
                  </>
                )}
              </div>

              <div className="form-group">
                <label>{t('contrib.paymentMethod')}</label>
                <select
                  value={payForm.payment_method}
                  onChange={(e) => setPayForm({ ...payForm, payment_method: e.target.value })}
                  disabled={paying}
                >
                  {/* Driven by the gateway registry in Settings. */}
                  {paymentMethods.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>{t('loans.referenceOptional')}</label>
                <input
                  type="text"
                  value={payForm.reference_number}
                  onChange={(e) =>
                    setPayForm({ ...payForm, reference_number: e.target.value })
                  }
                  placeholder={t('loans.referencePlaceholder')}
                  disabled={paying}
                />
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowPayModal(false)}
                  disabled={paying}
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  onClick={handlePay}
                  disabled={paying || !valid}
                >
                  <Wallet size={16} />{' '}
                  {paying
                    ? t('loans.recording')
                    : t('loans.payAmount', { amount: valid ? money(entered) : '' })}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Repayment Modal */}
      {showRepayModal && selectedLoan && (
        <div className="modal-overlay" onClick={() => setShowRepayModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('loans.recordRepaymentTitle')}</h2>
              <button className="modal-close" onClick={() => setShowRepayModal(false)}>&times;</button>
            </div>
            <p style={{ marginBottom: 16, color: '#666' }}>
              {t('loans.loanBalanceLabel')} <strong>{money(selectedLoan.balance)}</strong>
            </p>
            <form onSubmit={handleRepay}>
              <div className="form-group">
                <label>{t('contrib.amountLabel', { currency: form.currency || currencyCode })}</label>
                <input
                  type="number"
                  value={repayForm.amount}
                  onChange={(e) => setRepayForm({ ...repayForm, amount: e.target.value })}
                  max={selectedLoan.balance}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('contrib.paymentMethod')}</label>
                <select
                  value={repayForm.payment_method}
                  onChange={(e) => setRepayForm({ ...repayForm, payment_method: e.target.value })}
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
                  value={repayForm.reference_number}
                  onChange={(e) => setRepayForm({ ...repayForm, reference_number: e.target.value })}
                />
              </div>
              <button type="submit" className="btn btn-primary">{t('loans.recordPayment')}</button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default Loans;
