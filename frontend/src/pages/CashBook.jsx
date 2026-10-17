import React, { useState, useEffect } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import {
  Wallet,
  TrendingUp,
  TrendingDown,
  Plus,
  Receipt,
  Banknote,
  PiggyBank,
  Scale,
  Inbox,
  AlertTriangle,
  Trash2,
  RefreshCw,
  Info
} from 'lucide-react';
import StatCard from '../components/StatCard';
import { useAuth } from '../context/AuthContext';
import { useFormat } from '../context/FormatContext';
import { usePaymentGateways } from '../hooks/usePaymentGateways';
import { useI18n } from '../i18n/I18nContext';

// The ledger's own source values are fixed strings, so the visible wording is a
// lookup rather than the value itself.
const SOURCE_LABEL = {
  savings: 'cash.sourceSavings',
  repayment: 'cash.sourceRepayment',
  welfare_in: 'cash.sourceWelfareIn',
  expense: 'cash.sourceExpense',
  loan_disbursed: 'cash.sourceLoanOut',
  welfare_out: 'cash.sourceWelfareOut',
  other_in: 'cash.sourceOtherIn',
  other_out: 'cash.sourceOtherOut'
};

const IN_CATEGORIES = ['Interest collected', 'Donation received', 'Fines', 'Refund', 'Other income'];
const OUT_CATEGORIES = ['Donation given', 'Stationery', 'Transport', 'Bank charges', 'Meeting costs', 'Other spending'];

// Categories are stored and posted as these exact strings, so only the visible
// wording is translated; the submitted value stays as it is.
const CATEGORY_LABEL = {
  'Interest collected': 'cash.catInterestCollected',
  'Donation received': 'cash.catDonationReceived',
  Fines: 'cash.catFines',
  Refund: 'cash.catRefund',
  'Other income': 'cash.catOtherIncome',
  'Donation given': 'cash.catDonationGiven',
  Stationery: 'cash.catStationery',
  Transport: 'cash.catTransport',
  'Bank charges': 'cash.catBankCharges',
  'Meeting costs': 'cash.catMeetingCosts',
  'Other spending': 'cash.catOtherSpending'
};

const CashBook = () => {
  const { t } = useI18n();
  const { money: KES } = useFormat();
  const { hasPermission } = useAuth();
  const canRecord = hasPermission('record_contributions');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const { options: paymentMethods, loading: methodsLoading, pickDefault } = usePaymentGateways();
  const [error, setError] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [filter, setFilter] = useState('all'); // all | in | out

  // Keep the chosen method valid: switching a gateway off in Settings must not
  // leave this select holding a value that is no longer among its own options,
  // which would render blank and submit nothing.
  useEffect(() => {
    if (methodsLoading) return;
    setForm((f) => ({ ...f, payment_method: pickDefault(f.payment_method) }));
  }, [paymentMethods, methodsLoading, pickDefault]);

  const [form, setForm] = useState({
    direction: 'out',
    category: 'Other spending',
    description: '',
    amount: '',
    entry_date: new Date().toISOString().slice(0, 10),
    payment_method: 'cash',
    reference_number: ''
  });

  const load = async () => {
    setLoading(true);
    try {
      const res = await axios.get('/api/ledger/cashbook');
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(
        err.response?.status === 403
          ? t('cash.noPermission')
          : err.response?.data?.error || t('cash.loadFailed')
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      const res = await axios.post('/api/ledger', form);
      toast.success(res.data.message);
      setShowModal(false);
      setForm({
        direction: 'out',
        category: 'Other spending',
        description: '',
        amount: '',
        entry_date: new Date().toISOString().slice(0, 10),
        payment_method: 'cash',
        reference_number: ''
      });
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || t('cash.recordFailed'));
    }
  };

  const removeEntry = async (id) => {
    if (!confirm(t('cash.deleteConfirm'))) return;
    try {
      await axios.delete(`/api/ledger/${id}`);
      toast.success(t('cash.entryDeleted'));
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || t('cash.deleteFailed'));
    }
  };

  const onDirectionChange = (dir) => {
    setForm((f) => ({
      ...f,
      direction: dir,
      category: dir === 'in' ? IN_CATEGORIES[0] : OUT_CATEGORIES[0]
    }));
  };

  if (loading) {
    return (
      <div className="card">
        <div className="empty-state">
          <Inbox size={36} />
          <p>{t('cash.counting')}</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card">
        <div className="empty-state">
          <AlertTriangle size={36} style={{ color: 'var(--red)' }} />
          <p>{error}</p>
          <button className="btn btn-sm btn-secondary" onClick={load} style={{ marginTop: 12 }}>
            <RefreshCw size={14} /> {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  const { balance, position, money_in: moneyIn, money_out: moneyOut, entries, totals } = data;
  const categories = form.direction === 'in' ? IN_CATEGORIES : OUT_CATEGORIES;
  const maxOut = Math.max(...moneyOut.map((r) => r.total), 1);

  const visibleEntries = entries.filter((e) => {
    if (filter === 'all') return true;
    if (filter === 'in') return e.direction === 'in';
    return e.direction === 'out';
  });

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">{t('cash.title')}</h1>
          <p className="page-sub">
            {t('cash.subtitle')}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-secondary" onClick={load}>
            <RefreshCw size={16} /> {t('common.refresh')}
          </button>
          {canRecord && (
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>
              <Plus size={17} /> {t('cash.recordMoney')}
            </button>
          )}
        </div>
      </div>

      {/* ---------------------------------------------- current balance hero */}
      <div className={`balance-hero${balance.closing < 0 ? ' is-negative' : ''}`}>
        <div className="balance-hero-main">
          <div className="balance-hero-label">
            <Wallet size={18} /> {t('cash.currentBalance')}
          </div>
          <div className="balance-hero-value">{KES(balance.closing)}</div>
          <div className="balance-hero-sub">
            {t('cash.balanceSub', { date: new Date().toLocaleDateString() })}
          </div>
        </div>

        <div className="balance-hero-flow">
          <div className="flow-block flow-in">
            <div className="flow-label">
              <TrendingUp size={16} /> {t('cash.moneyIn')}
            </div>
            <div className="flow-value">+ {KES(balance.total_in)}</div>
          </div>
          <div className="flow-arrow">→</div>
          <div className="flow-block flow-out">
            <div className="flow-label">
              <TrendingDown size={16} /> {t('cash.moneyOut')}
            </div>
            <div className="flow-value">− {KES(balance.total_out)}</div>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------------- position */}
      <div className="stats-grid">
        <StatCard
          icon={Banknote}
          label={t('cash.owedByMembers')}
          value={KES(position.receivable_from_members)}
          hint={t('cash.hintLoansToRecover')}
          tone="purple"
        />
        <StatCard
          icon={Scale}
          label={t('cash.netWorth')}
          value={KES(position.net_worth)}
          hint={t('cash.hintNetWorth')}
          tone="blue"
        />
        <StatCard
          icon={PiggyBank}
          label={t('cash.heldForMembers')}
          value={KES(position.held_for_members)}
          hint={t('cash.hintHeld')}
          tone="pink"
        />
        <StatCard
          icon={Receipt}
          label={t('cash.realSpending')}
          value={KES(totals.operating_spend_only)}
          hint={t('cash.hintExcludesLent')}
          tone="orange"
        />
      </div>

      <div className="trust-note">
        <Info size={18} />
        <div>
          <strong>{t('cash.loanNotSpending')}</strong>
          <span>
            {KES(position.receivable_from_members)}{' '}
            {t('cash.loanNotSpendingNote')}{' '}
            {KES(totals.operating_spend_only)}. {t('cash.memberSavingsOf')}{' '}
            {KES(position.held_for_members)} {t('cash.heldForMembersNote')}
          </span>
        </div>
      </div>

      {/* ------------------------------------------------- in / out breakdown */}
      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <TrendingUp size={18} /> {t('cash.moneyIn')}
            </h3>
            <span className="badge badge-success">+ {KES(balance.total_in)}</span>
          </div>

          {moneyIn.length === 0 ? (
            <div className="empty-state">
              <Inbox size={30} />
              <p>{t('cash.noMoneyIn')}</p>
            </div>
          ) : (
            <div className="breakdown">
              {moneyIn.map((r) => (
                <div key={r.category} className="breakdown-row">
                  <div className="breakdown-top">
                    <span className="breakdown-label">
                      {CATEGORY_LABEL[r.category]
                        ? t(CATEGORY_LABEL[r.category])
                        : r.category}
                    </span>
                    <span className="breakdown-amount">{KES(r.total)}</span>
                  </div>
                  <div className="breakdown-bar">
                    <span
                      style={{
                        width: `${Math.max(6, (r.total / Math.max(...moneyIn.map((x) => x.total), 1)) * 100)}%`,
                        background: 'linear-gradient(90deg,var(--brand),var(--accent))'
                      }}
                    />
                  </div>
                  <div className="breakdown-meta">
                    {r.count === 1 ? t('cash.transactionOne') : t('cash.transactions', { n: r.count })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <h3 className="card-title">
              <TrendingDown size={18} /> {t('cash.moneyOut')}
            </h3>
            <span className="badge badge-danger">− {KES(balance.total_out)}</span>
          </div>

          {moneyOut.length === 0 ? (
            <div className="empty-state">
              <Inbox size={30} />
              <p>{t('cash.noMoneyOut')}</p>
            </div>
          ) : (
            <div className="breakdown">
              {moneyOut.map((r) => (
                <div key={r.category} className="breakdown-row">
                  <div className="breakdown-top">
                    <span className="breakdown-label">
                      {CATEGORY_LABEL[r.category]
                        ? t(CATEGORY_LABEL[r.category])
                        : r.category}
                    </span>
                    <span className="breakdown-amount">{KES(r.total)}</span>
                  </div>
                  <div className="breakdown-bar">
                    <span
                      style={{
                        width: `${Math.max(6, (r.total / maxOut) * 100)}%`,
                        background: 'linear-gradient(90deg,var(--orange),var(--red))'
                      }}
                    />
                  </div>
                  <div className="breakdown-meta">
                    {r.count === 1 ? t('cash.transactionOne') : t('cash.transactions', { n: r.count })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------ itemised ledger */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            <Receipt size={18} /> {t('cash.itemisedLedger')}
          </h3>
          <div className="filter-pills">
            {['all', 'in', 'out'].map((f) => (
              <button
                key={f}
                className={`filter-pill${filter === f ? ' active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? t('common.all') : f === 'in' ? t('cash.moneyIn') : t('cash.moneyOut')}
              </button>
            ))}
          </div>
        </div>

        {visibleEntries.length === 0 ? (
          <div className="empty-state">
            <Inbox size={34} />
            <p>{t('cash.noEntriesShow')}</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('common.date')}</th>
                  <th>{t('common.description')}</th>
                  <th>{t('cash.type')}</th>
                  <th>{t('common.method')}</th>
                  <th style={{ textAlign: 'right' }}>{t('common.amount')}</th>
                  {canRecord && <th />}
                </tr>
              </thead>
              <tbody>
                {visibleEntries.map((e) => (
                  <tr key={`${e.source}-${e.id}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {new Date(e.entry_date).toLocaleDateString()}
                    </td>
                    <td style={{ maxWidth: 340 }}>{e.description}</td>
                    <td>
                      <span className={`badge badge-${e.direction === 'in' ? 'success' : 'warning'}`}>
                        {SOURCE_LABEL[e.source] ? t(SOURCE_LABEL[e.source]) : e.source}
                      </span>
                    </td>
                    <td style={{ textTransform: 'uppercase', fontSize: 12, color: '#64748b' }}>
                      {e.payment_method}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontWeight: 700,
                        fontVariantNumeric: 'tabular-nums',
                        color: e.direction === 'in' ? '#15803d' : '#b91c1c',
                        whiteSpace: 'nowrap'
                      }}
                    >
                      {e.direction === 'in' ? '+' : '−'} {KES(e.amount)}
                    </td>
                    {canRecord && (
                      <td style={{ textAlign: 'right' }}>
                        {(e.source === 'other_in' || e.source === 'other_out') && (
                          <button
                            className="btn btn-sm btn-danger"
                            onClick={() => removeEntry(e.id)}
                            aria-label={t('cash.deleteEntry')}
                          >
                            <Trash2 size={13} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* -------------------------------------------------------- record modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{form.direction === 'in' ? t('cash.recordReceived') : t('cash.recordPaidOut')}</h2>
              <button className="modal-close" onClick={() => setShowModal(false)}>
                &times;
              </button>
            </div>

            <div className="direction-toggle">
              <button
                className={`direction-btn${form.direction === 'in' ? ' active in' : ''}`}
                onClick={() => onDirectionChange('in')}
              >
                <TrendingUp size={16} /> {t('cash.moneyIn')}
              </button>
              <button
                className={`direction-btn${form.direction === 'out' ? ' active out' : ''}`}
                onClick={() => onDirectionChange('out')}
              >
                <TrendingDown size={16} /> {t('cash.moneyOut')}
              </button>
            </div>

            <form onSubmit={submit}>
              <div className="form-group">
                <label>{t('cash.category')} *</label>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  required
                >
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABEL[c] ? t(CATEGORY_LABEL[c]) : c}
                    </option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label>{t('common.description')} *</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  rows={3}
                  placeholder={t('cash.descriptionPlaceholder')}
                  required
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>{t('cash.amountLabel', { currency: form.currency || currencyCode })}</label>
                  <input
                    type="number"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    min="1"
                    step="0.01"
                    required
                  />
                </div>
                <div className="form-group">
                  <label>{t('common.date')} *</label>
                  <input
                    type="date"
                    value={form.entry_date}
                    onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
                    required
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>{t('common.method')}</label>
                  <select
                    value={form.payment_method}
                    onChange={(e) => setForm({ ...form, payment_method: e.target.value })}
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
                  <label>{t('common.reference')}</label>
                  <input
                    type="text"
                    value={form.reference_number}
                    onChange={(e) => setForm({ ...form, reference_number: e.target.value })}
                    placeholder={t('cash.receiptPlaceholder')}
                  />
                </div>
              </div>

              <button type="submit" className="btn btn-primary btn-block">
                {t('cash.saveEntry')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default CashBook;
