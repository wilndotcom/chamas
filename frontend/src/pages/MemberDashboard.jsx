import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import {
  Coins,
  Banknote,
  Wallet,
  Percent,
  Heart,
  Calendar,
  Smartphone,
  TrendingUp,
  CheckCircle,
  Plus,
  Inbox,
  ShieldCheck
} from 'lucide-react';
import StatCard, { QuickAction } from '../components/StatCard';
import { useFormat } from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';

// Member-facing wording, so "pending" reads as "waiting for the committee"
// rather than exposing internal status names.
const STATUS_BADGE = {
  pending: 'badge-warning',
  approved: 'badge-info',
  active: 'badge-success',
  disbursed: 'badge-info',
  completed: 'badge-success',
  rejected: 'badge-danger',
  defaulted: 'badge-danger'
};

// Translation keys rather than words, so the labels follow the chosen language.
// An unknown status falls through to the raw value, as before.
const STATUS_LABEL = {
  pending: 'dash.awaitingApproval',
  approved: 'status.approved',
  active: 'status.active',
  disbursed: 'status.disbursed',
  completed: 'dash.repaidInFull',
  rejected: 'dash.declined',
  defaulted: 'status.defaulted'
};

const MemberDashboard = () => {
  const { money, opts: fmt } = useFormat();
  const { t } = useI18n();
  const currencyCode = fmt.currency || 'KES';
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetchDashboard();
  }, []);

  const fetchDashboard = async () => {
    try {
      // One request. The endpoint now returns the member's loans and welfare
      // requests too, so no extra calls that a member is not allowed to make.
      const { data } = await axios.get('/api/members/dashboard');
      setData(data);
    } catch (error) {
      console.error('Failed to fetch member dashboard:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="empty-state">
        <Inbox size={40} />
        <p>{t('dash.loadingYour')}</p>
      </div>
    );
  }

  const totalContributions = Number(data?.total_contributions || 0);
  const loanBalance = Number(data?.loan_balance || 0);
  const transactions = data?.recent_transactions || [];
  const applications = data?.loans || [];
  const summary = data?.loan_summary;
  const hasLoan = summary && summary.open_loan_count > 0;
  const pendingApplications = applications.filter((l) => l.status === 'pending');
  const memberSince = data?.member?.joined_date
    ? new Date(data.member.joined_date).toLocaleDateString('default', { day: 'numeric', month: 'short', year: 'numeric' })
    : '”';
  const firstName = (data?.member?.full_name || '').split(' ')[0];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t('dash.memberGreeting', { name: firstName || t('dash.memberFallback') })}! 👋
          </h1>
          <p className="page-sub">{t('dash.summaryAtGlance')}</p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => navigate('/contributions')}>
            <Smartphone size={17} /> {t('dash.payWithMpesa')}
          </button>
        </div>
      </div>

      <div className="stats-grid">
        <StatCard
          icon={Coins}
          label={t('dash.myContributions')}
          value={`${money(totalContributions)}`}
          hint={t('dash.savedSoFar')}
          tone="green"
        />
        <StatCard
          icon={Wallet}
          label={t('dash.totalOutstanding')}
          value={`${money(summary ? summary.total_balance : loanBalance)}`}
          hint={
            summary && summary.open_loan_count > 0
              ? t(summary.open_loan_count === 1 ? 'dash.acrossLoan' : 'dash.acrossLoans', {
                  n: summary.open_loan_count
                })
              : t('dash.noActiveLoan')
          }
          tone={summary && summary.open_loan_count > 0 ? 'orange' : 'teal'}
        />
        <StatCard
          icon={Percent}
          label={t('dash.interestToPay')}
          value={`${money(summary ? summary.interest_outstanding : 0)}`}
          hint={
            summary && summary.open_loan_count > 0
              ? t('dash.plusPrincipal', { amount: money(summary.principal_outstanding) })
              : t('dash.nothingOutstanding')
          }
          tone={summary && summary.interest_outstanding > 0 ? 'amber' : 'teal'}
        />
        <StatCard
          icon={Calendar}
          label={t('dash.memberSince')}
          value={memberSince}
          hint={`${data?.member?.phone || ''}`}
          tone="blue"
        />
        <StatCard
          icon={ShieldCheck}
          label={t('dash.accountStatus')}
          value={data?.member?.status === 'active' ? t('status.active') : data?.member?.status}
          hint={t('dash.inGoodStanding')}
          tone="purple"
        />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">
                <TrendingUp size={18} /> {t('dash.recentTransactions')}
              </h3>
              <p className="card-sub">{t('dash.lastFewContributions')}</p>
            </div>
            <button className="btn btn-sm btn-secondary" onClick={() => navigate('/contributions')}>
              {t('common.viewAll')}
            </button>
          </div>

          {transactions.length === 0 ? (
            <div className="empty-state">
              <Inbox size={34} />
              <p>{t('dash.noTransactions')}</p>
            </div>
          ) : (
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>{t('common.date')}</th>
                    <th>{t('common.amount')}</th>
                    <th>{t('common.method')}</th>
                    <th>{t('common.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Named tx, not t: t is the translator in this component. */}
                  {transactions.map((tx) => (
                    <tr key={tx.id}>
                      <td>{new Date(tx.contribution_date).toLocaleDateString()}</td>
                      <td style={{ fontWeight: 600 }}>{money(Number(tx.amount))}</td>
                      <td style={{ textTransform: 'uppercase', fontSize: 12, color: '#64748b' }}>
                        {tx.payment_method}
                      </td>
                      <td>
                        <span className={`badge badge-${tx.status === 'confirmed' ? 'success' : 'warning'}`}>
                          {tx.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">
                <Banknote size={18} /> {t('dash.whatYouOwe')}
              </h3>
              <p className="card-sub">
                {summary && summary.settled_loan_count > 0
                  ? t('dash.plusRepaid', { n: summary.settled_loan_count })
                  : t('dash.brokenDown')}
              </p>
            </div>
            {hasLoan && (
              <button className="btn btn-sm btn-primary" onClick={() => navigate('/loans')}>
                {t('dash.goToMyLoans')}
              </button>
            )}
          </div>

          {!hasLoan ? (
            <div className="empty-state">
              <CheckCircle size={40} style={{ color: '#16a34a' }} />
              <p style={{ fontWeight: 600, color: '#0f172a' }}>{t('dash.noActiveLoanTitle')}</p>
              <p style={{ fontSize: 13 }}>{t('dash.keepContributing')}</p>
            </div>
          ) : (
            <>
              <div className="owe-hero">
                <div className="owe-hero-total">
                  <span>{t('dash.totalOutstanding')}</span>
                  <strong>{money(summary.total_balance)}</strong>
                  <em>
                    {t(summary.open_loan_count === 1 ? 'dash.acrossLoan' : 'dash.acrossLoans', {
                      n: summary.open_loan_count
                    })}
                  </em>
                </div>

                <div className="owe-split">
                  <div className="owe-split-row">
                    <span className="owe-dot" style={{ background: '#2563eb' }} />
                    <span className="owe-split-label">{t('dash.principalStillToPay')}</span>
                    <strong>{money(summary.principal_outstanding)}</strong>
                  </div>
                  <div className="owe-split-row">
                    <span className="owe-dot" style={{ background: '#f97316' }} />
                    <span className="owe-split-label">{t('dash.interestStillToPay')}</span>
                    <strong style={{ color: '#c2410c' }}>{money(summary.interest_outstanding)}</strong>
                  </div>
                  <div className="owe-split-row owe-split-total">
                    <span />
                    <span className="owe-split-label">{t('dash.totalToClear')}</span>
                    <strong>{money(summary.total_balance)}</strong>
                  </div>
                </div>
              </div>

              <div className="owe-progress">
                <div className="owe-progress-head">
                  <span>{t('dash.repaymentProgress')}</span>
                  <span>
                    {t('dash.paidOf', {
                      paid: money(summary.amount_paid),
                      total: money(summary.total_repayable)
                    })}
                  </span>
                </div>
                <div className="progress">
                  <span style={{ width: `${summary.repaid_percent}%` }} />
                </div>
                <div className="owe-progress-foot">
                  <strong>{t('dash.percentRepaid', { n: summary.repaid_percent })}</strong>
                  {summary.next_due_date && (
                    <span
                      className={
                        summary.is_overdue ? 'owe-overdue' : ''
                      }
                    >
                      {summary.is_overdue
                        ? t('dash.overdueSince', {
                            date: new Date(summary.next_due_date).toLocaleDateString()
                          })
                        : t('dash.dueIn', {
                            date: new Date(summary.next_due_date).toLocaleDateString(),
                            n: summary.days_to_due
                          })}
                    </span>
                  )}
                </div>
              </div>

              <p className="owe-note">{t('dash.interestNote')}</p>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title">
              <Banknote size={18} /> {t('dash.myLoanApplications')}
            </h3>
            <p className="card-sub">
              {applications.length === 0
                ? t('dash.notAppliedYet')
                : t(
                    applications.length === 1
                      ? 'dash.applicationOne'
                      : 'dash.applicationMany',
                    { n: applications.length }
                  )}
            </p>
          </div>
          <button className="btn btn-sm btn-primary" onClick={() => navigate('/loans')}>
            {t('dash.applyForLoan')}
          </button>
        </div>

        {applications.length === 0 ? (
          <div className="empty-state">
            <Inbox size={34} />
            <p>{t('dash.noApplications')}</p>
          </div>
        ) : (
          <div className="table-container">
            <table>
              <thead>
                <tr>
                  <th>{t('loans.applyDate')}</th>
                  <th>{t('common.amount')}</th>
                  <th>{t('loans.purpose')}</th>
                  <th>{t('loans.interestAmount')}</th>
                  <th>{t('dash.owedNow')}</th>
                  <th>{t('dash.due')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((l) => (
                  <tr key={l.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {new Date(l.application_date).toLocaleDateString()}
                    </td>
                    <td style={{ fontWeight: 600 }}>{money(Number(l.principal_amount))}</td>
                    <td style={{ fontSize: 13, color: '#475569', maxWidth: 160 }}>{l.purpose}</td>
                    <td>
                      {money(Number(l.interest_amount))}
                      <div style={{ fontSize: 11, color: '#94a3b8' }}>{l.interest_rate}%</div>
                    </td>
                    <td style={{ fontWeight: 700 }}>
                      {money(Number(l.balance))}
                      {l.is_open && l.interest_outstanding > 0 && (
                        <div style={{ fontSize: 11, fontWeight: 500, color: '#c2410c' }}>
                          {t('dash.inclInterest', { amount: money(l.interest_outstanding) })}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
                      {l.due_date ? new Date(l.due_date).toLocaleDateString() : '”'}
                    </td>
                    <td>
                      <span className={`badge badge--plain ${STATUS_BADGE[l.status] || 'badge-info'}`}>
                        {STATUS_LABEL[l.status] ? t(STATUS_LABEL[l.status]) : l.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title">{t('dash.whatYouCanDo')}</h3>
        </div>
        <div className="quick-actions">
          <QuickAction
            icon={Smartphone}
            title={t('dash.payViaMpesa')}
            subtitle={t('dash.promptOnPhone')}
            tone="green"
            onClick={() => navigate('/contributions')}
          />
          <QuickAction
            icon={Banknote}
            title={t('loans.apply')}
            subtitle={t('dash.borrowFromGroup')}
            tone="purple"
            onClick={() => navigate('/loans')}
          />
          <QuickAction
            icon={Heart}
            title={t('welfare.request')}
            subtitle={t('dash.helpInHardTimes')}
            tone="pink"
            onClick={() => navigate('/welfare')}
          />
          <QuickAction
            icon={Coins}
            title={t('dash.myStatements')}
            subtitle={t('dash.fullHistory')}
            tone="blue"
            onClick={() => navigate('/contributions')}
          />
        </div>
      </div>
    </div>
  );
};

export default MemberDashboard;
