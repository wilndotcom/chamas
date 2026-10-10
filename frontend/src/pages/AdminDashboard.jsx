import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { adminPath } from '../routes';
import toast from 'react-hot-toast';
import {
  Wallet,
  Banknote,
  PiggyBank,
  BellRing,
  ArrowRight,
  Inbox,
  Users,
  CheckCircle,
  Clock,
  UserCheck,
  Send,
  AlertTriangle,
  Plus,
  Smartphone,
  FileText,
  Heart
} from 'lucide-react';
import {
  ComposedChart,
  Bar,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer
} from 'recharts';
import StatCard, { QuickAction } from '../components/StatCard';
import { useFormat } from '../context/FormatContext';
import { useAuth } from '../context/AuthContext';
import { useI18n } from '../i18n/I18nContext';

/**
 * Super admin / admin dashboard.
 *
 * Deliberately short. It answers four questions in order, then lists what needs
 * a decision:
 *   1. Can we pay people?      -> cash in bank
 *   2. Who owes us?           -> loans outstanding and recovery
 *   3. Are we growing?        -> member savings trend
 *   4. Are we earning?        -> profit after costs
 * Anything not answering one of those, or duplicating another widget, was cut.
 */
const AdminDashboard = () => {
  const { user, hasPermission, loading: authLoading } = useAuth();
  const { money, number, percent } = useFormat();
  const { t } = useI18n();
  const navigate = useNavigate();

  const can = (p) => hasPermission(p);

  const [cash, setCash] = useState(null);
  const [growth, setGrowth] = useState(null);
  const [risk, setRisk] = useState(null);
  const [pendingLoans, setPendingLoans] = useState([]);
  const [pendingRegs, setPendingRegs] = useState([]);
  const [loading, setLoading] = useState(true);
  // Guards against a second fetch when `ready` flips and re-runs the effect.
  const [loaded, setLoaded] = useState(false);
  const [reminding, setReminding] = useState(false);

  /**
   * Loads the dashboard's figures.
   *
   * Every request is gated on a permission, and permissions arrive from
   * AuthContext after this component mounts. With an empty dependency array the
   * effect ran once, before they were known, so every check was false, no request
   * was made and the dashboard stayed permanently blank on a fast connection.
   * Depending on `ready` is what makes it correct whether the profile is cached or
   * fetched.
   */
  useEffect(() => {
    // AuthContext is still resolving the profile, so permissions are not known yet.
    if (authLoading) return;
    if (loaded) return;

    setLoaded(true);
    const grab = (cond, url, pick) =>
      cond ? axios.get(url).then((r) => pick(r.data)).catch(() => null) : Promise.resolve(null);

    const only = (cond, url, pick) =>
      cond ? axios.get(url).then((r) => pick(r.data)).catch(() => null) : Promise.resolve(null);

    Promise.all([
      grab(can('view_reports'), '/api/ledger/cashbook', (d) => d),
      grab(can('view_reports'), '/api/reports/growth', (d) => d),
      only(can('view_reports') || can('send_notifications'), '/api/reports/reminders', (d) => d),
      only(can('approve_loans'), '/api/loans/pending', (d) => d.loans),
      only(can('manage_members'), '/api/members/registrations', (d) => d.pending)
    ]).then(([c, g, r, l, reg]) => {
      setCash(c);
      setGrowth(g);
      setRisk(r);
      setPendingLoans(l || []);
      setPendingRegs(reg || []);
    }).finally(() => setLoading(false));
  }, [authLoading, loaded]);

  const sendReminders = async () => {
    setReminding(true);
    try {
      const res = await axios.post('/api/notifications/remind', { channels: ['sms'] });
      if (res.data.sent > 0) toast.success(res.data.message);
      else toast.error(t('dash.noSmsProvider'));
    } catch (error) {
      toast.error(error.response?.data?.error || t('dash.remindFailed'));
    } finally {
      setReminding(false);
    }
  };

  if (loading) {
    return (
      <div className="card">
        <div className="empty-state">
          <Inbox size={34} />
          <p>{t('dash.gathering')}</p>
        </div>
      </div>
    );
  }

  const behind = risk?.summary.total || 0;
  const attention = pendingLoans.length + pendingRegs.length + behind;
  const firstName = (user?.full_name || '').split(' ')[0];

  const profit = growth?.profit;
  const profitable = profit && profit.net_profit >= 0;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t('dash.adminGreeting', { name: firstName || t('dash.adminFallback') })}
          </h1>
          <p className="page-sub">
            {attention > 0
              ? t(attention === 1 ? 'dash.attentionOne' : 'dash.attentionMany', { n: attention })
              : t('dash.allClear')}
          </p>
        </div>
        {can('record_contributions') && (
          <div className="page-actions">
            <button className="btn btn-primary" onClick={() => navigate(adminPath('contributions'))}>
              <Plus size={17} /> {t('contrib.record')}
            </button>
          </div>
        )}
      </div>

      {/* Explains the missing money tiles for roles without report access,
          rather than leaving the page looking broken. */}
      {!can('view_reports') && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">{t('dash.yourRole')}</h3>
          </div>
          <p style={{ color: 'var(--text-soft)', fontSize: 14, lineHeight: 1.7 }}>
            {t('dash.roleLimits')}
          </p>
        </div>
      )}

      {/* ------------------------------------------- 1. the four questions */}
      {/* Tiles are hidden, not zeroed: an admin without view_reports must not
          see "KSh 0" for the bank's balance, which would read as "no money".

          The first question - can we pay people - gets the lead tile and a row of
          its own. The rest sit below it as supporting figures. Four equal tiles
          left the reader to work out which number mattered, which is the one job
          this screen exists to do. */}
      <div className="glance-grid">
        {can('view_reports') && (
          <StatCard
            hero
            icon={Wallet}
            label={t('dash.cashInBank')}
            value={money(cash ? cash.balance.closing : 0)}
            hint={
              cash && growth
                ? t('dash.netWorth', {
                    v: money(growth.loans.outstanding + cash.balance.closing)
                  })
                : t('dash.availableToPay')
            }
            tone="green"
          />
        )}

        {can('view_reports') && growth && (
          <StatCard
            light
            icon={Banknote}
            label={t('cash.owedByMembers')}
            value={money(growth.loans.outstanding)}
            hint={t('dash.recoveredSoFar', { n: growth.loans.recovery_rate })}
            tone="purple"
          />
        )}

        {can('view_reports') && growth && (
          <StatCard
            light
            icon={PiggyBank}
            label={t('dash.memberSavings')}
            value={money(growth.summary.total_savings)}
            hint={
              growth.summary.growth_rate !== 0
                ? t('dash.growthThisMonth', {
                    sign: growth.summary.growth_rate > 0 ? '+' : '',
                    n: growth.summary.growth_rate
                  })
                : t('dash.membersSaving', { n: growth.summary.member_count })
            }
            tone="blue"
          />
        )}

        {/* The one tile whose colour carries the message, so it is the only one
            left filled: red when something needs a decision, quiet when it does
            not. Filling it green as well would spend the warning twice. */}
        <StatCard
          light={attention === 0}
          icon={attention > 0 ? BellRing : CheckCircle}
          label={t('dash.needsAttention')}
          value={attention}
          hint={
            attention === 0
              ? t('dash.allClearShort')
              : [
                  pendingLoans.length &&
                    t(pendingLoans.length === 1 ? 'dash.loanOne' : 'dash.loanMany', {
                      n: pendingLoans.length
                    }),
                  pendingRegs.length &&
                    t(pendingRegs.length === 1 ? 'dash.regOne' : 'dash.regMany', {
                      n: pendingRegs.length
                    }),
                  behind && t('dash.behindOnSavings', { n: behind })
                ]
                  .filter(Boolean)
                  .join(' · ')
          }
          tone={attention > 0 ? 'red' : 'teal'}
        />
      </div>

      {/* ------------------------------------- 2. money position + growth */}
      <div className="grid-2">
        {cash && (
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">
                  <Wallet size={18} /> {t('dash.moneyPosition')}
                </h3>
                <p className="card-sub">{t('dash.whereMoneyWent')}</p>
              </div>
              <button className="btn btn-sm btn-secondary" onClick={() => navigate(adminPath('cashbook'))}>
                {t('nav.cashbook')} <ArrowRight size={13} />
              </button>
            </div>

            <div className="flow-list">
              <div className="flow-list-row in">
                <span>{t('dash.receivedFromMembers')}</span>
                <strong>{money(cash.balance.total_in)}</strong>
              </div>
              <div className="flow-list-row out receivable">
                <span>
                  {t('dash.lentOutAsLoans')}
                  <em>{t('dash.becomesOwed')}</em>
                </span>
                <strong>− {money(cash.money_out.find((r) => r.category.includes('Loans'))?.total || 0)}</strong>
              </div>
              <div className="flow-list-row out">
                <span>{t('dash.runningCosts')}</span>
                <strong>− {money(cash.money_out.find((r) => r.category.includes('Operating'))?.total || 0)}</strong>
              </div>
              <div className="flow-list-row out">
                <span>{t('dash.welfarePaidOut')}</span>
                <strong>− {money(cash.money_out.find((r) => r.category.includes('Welfare'))?.total || 0)}</strong>
              </div>
              <div className="flow-list-row total">
                <span>{t('dash.changeInCash')}</span>
                <strong>
                  {cash.balance.total_in - cash.balance.total_out >= 0 ? '+' : '−'}
                  {money(Math.abs(cash.balance.total_in - cash.balance.total_out))}
                </strong>
              </div>
            </div>

            {profit && (
              <div className={`profit-strip${profitable ? ' good' : ' bad'}`}>
                <div>
                  <span>{t('dash.netProfit')}</span>
                  <strong>{money(profit.net_profit)}</strong>
                </div>
                <div className="profit-strip-sep" />
                <div>
                  <span>{t('dash.earnedOnInterest')}</span>
                  <strong>{money(profit.income)}</strong>
                </div>
                <div className="profit-strip-sep" />
                <div>
                  <span>{t('dash.realSpending')}</span>
                  <strong>{money(cash?.totals.operating_spend_only || 0)}</strong>
                </div>
              </div>
            )}
          </div>
        )}

        {growth && growth.monthly.some((m) => m.contributions > 0) && (
          <div className="card">
            <div className="card-header">
              <div>
                <h3 className="card-title">
                  <PiggyBank size={18} /> {t('dash.savingsGrowth')}
                </h3>
                <p className="card-sub">{t('dash.memberSavings12')}</p>
              </div>
            </div>

            <div className="mini-stat-row">
              <div>
                <span>{t('nav.members')}</span>
                <strong>{number(growth.summary.member_count)}</strong>
              </div>
              <div>
                <span>{t('dash.averageSaved')}</span>
                <strong>{money(growth.summary.average_per_member)}</strong>
              </div>
              <div>
                <span>{t('dash.loanRecovery')}</span>
                <strong>{percent(growth.loans.recovery_rate)}</strong>
              </div>
            </div>

            <div className="chart-box" style={{ height: 220 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={growth.monthly} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="dashCum" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 4" stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--text-faint)' }}
                    axisLine={false}
                    tickLine={false}
                    interval={1}
                  />
                  {/* Left axis for the monthly bars (axis 0, the default target) */}
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--text-faint)' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)}
                  />
                  {/* Right axis for the cumulative savings line */}
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 11, fill: 'var(--text-faint)' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : v)}
                  />
                  <Tooltip
                    formatter={(v, name) => [
                      money(v),
                      name === 'cumulative_savings' ? t('dash.totalSaved') : t('dash.savedThatMonth')
                    ]}
                    contentStyle={{ borderRadius: 12, border: '1px solid var(--line)' }}
                  />
                  <Bar
                    yAxisId={0}
                    dataKey="contributions"
                    fill="var(--accent)"
                    radius={[5, 5, 0, 0]}
                    maxBarSize={22}
                  />
                  <Area
                    yAxisId="right"
                    type="monotone"
                    dataKey="cumulative_savings"
                    stroke="var(--brand)"
                    strokeWidth={2.5}
                    fill="url(#dashCum)"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* --------------------------------------------- 3. what needs action */}
      {(pendingLoans.length > 0 || pendingRegs.length > 0 || behind > 0) && (
        <div className="card">
          <div className="card-header">
            <div>
              <h3 className="card-title">
                <AlertTriangle size={18} /> {t('dash.waitingOnYou')}
              </h3>
              <p className="card-sub">{t('dash.decisionsFollowUps')}</p>
            </div>
          </div>

          <div className="attention-list">
            {pendingLoans.length > 0 && (
              <div className="attention-item">
                <span className="attention-icon warn"><Banknote size={17} /></span>
                <div className="attention-text">
                  <strong>
                    {t(pendingLoans.length === 1 ? 'dash.loanAppOne' : 'dash.loanAppMany', {
                      n: pendingLoans.length
                    })}
                  </strong>
                  <span>
                    {t('dash.requestedOldest', {
                      amount: money(
                        pendingLoans.reduce((sum, l) => sum + Number(l.principal_amount), 0)
                      ),
                      date: new Date(
                        pendingLoans[pendingLoans.length - 1].application_date
                      ).toLocaleDateString()
                    })}
                  </span>
                </div>
                <button className="btn btn-sm btn-primary" onClick={() => navigate(adminPath('loans'))}>
                  {t('reg.review')}
                </button>
              </div>
            )}

            {pendingRegs.length > 0 && (
              <div className="attention-item">
                <span className="attention-icon warn"><UserCheck size={17} /></span>
                <div className="attention-text">
                  <strong>
                    {t(pendingRegs.length === 1 ? 'dash.reqOne' : 'dash.reqMany', {
                      n: pendingRegs.length
                    })}
                  </strong>
                  <span>
                    {pendingRegs.map((m) => m.full_name).slice(0, 3).join(', ')}
                    {pendingRegs.length > 3 ? t('dash.andMore') : ''}
                  </span>
                </div>
                <button className="btn btn-sm btn-primary" onClick={() => navigate(adminPath('registrations'))}>
                  {t('reg.review')}
                </button>
              </div>
            )}

            {behind > 0 && (
              <div className="attention-item">
                <span className="attention-icon danger"><Clock size={17} /></span>
                <div className="attention-text">
                  <strong>{t('dash.behindOnSavings', { n: behind })}</strong>
                  <span>
                    {t(
                      risk.summary.overdue_loans > 0
                        ? 'dash.overdueLoansSome'
                        : 'dash.overdueLoansNone',
                      { amount: money(risk.summary.total_amount), n: risk.summary.overdue_loans }
                    )}
                  </span>
                </div>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={sendReminders}
                  disabled={reminding}
                >
                  <Send size={14} /> {reminding ? t('dash.sending') : t('dash.remind')}
                </button>
              </div>
            )}
          </div>

          {risk && risk.members.length > 0 && (
            <div className="behind-table-wrap">
              <table className="behind-table">
                <thead>
                  <tr>
                    <th>{t('nav.members')}</th>
                    <th>{t('dash.why')}</th>
                    <th style={{ textAlign: 'right' }}>{t('dash.owing')}</th>
                  </tr>
                </thead>
                <tbody>
                  {risk.members.slice(0, 5).map((m) => (
                    <tr key={m.member_id}>
                      <td style={{ fontWeight: 600 }}>{m.full_name}</td>
                      <td style={{ fontSize: 13, color: 'var(--text-soft)' }}>{m.detail}</td>
                      <td style={{ textAlign: 'right', fontWeight: 700 }}>{money(m.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {risk.members.length > 5 && (
                <p className="behind-more">
                  {t('dash.andCountMore', { n: risk.members.length - 5 })}{' '}
                  <button className="link-btn" onClick={() => navigate(adminPath('contributions'))}>
                    {t('dash.seeEveryone')}
                  </button>
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------ quick moves */}
      {can('record_contributions') && (
        <div className="card">
          <div className="card-header">
            <h3 className="card-title">{t('dash.quickMoves')}</h3>
          </div>
          <div className="quick-actions">
            <QuickAction
              icon={Coins2}
              title={t('contrib.record')}
              subtitle={t('dash.cashOrMpesa')}
              tone="green"
              onClick={() => navigate(adminPath('contributions'))}
            />
            <QuickAction
              icon={Users}
              title={t('nav.members')}
              subtitle={t('dash.addOrManage')}
              tone="blue"
              onClick={() => navigate(adminPath('members'))}
            />
            {can('view_reports') && (
              <QuickAction
                icon={FileText}
                title={t('nav.cashbook')}
                subtitle={t('dash.moneyInOut')}
                tone="orange"
                onClick={() => navigate(adminPath('cashbook'))}
              />
            )}
            {can('manage_welfare') && (
              <QuickAction
                icon={Heart}
                title={t('nav.welfare')}
                subtitle={t('dash.requestsOnly')}
                tone="pink"
                onClick={() => navigate(adminPath('welfare'))}
              />
            )}
            {can('approve_loans') && (
              <QuickAction
                icon={Banknote}
                title={t('nav.loans')}
                subtitle={
                  pendingLoans.length
                    ? t('dash.toReview', { n: pendingLoans.length })
                    : t('dash.allReviewed')
                }
                tone="purple"
                onClick={() => navigate(adminPath('loans'))}
              />
            )}
            {can('send_notifications') && (
              <QuickAction
                icon={Smartphone}
                title={t('dash.notify')}
                subtitle={t('dash.messageMembers')}
                tone="cyan"
                onClick={() => navigate(adminPath('notifications'))}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const Coins2 = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="8" cy="8" r="6" />
    <path d="M18.09 10.37A6 6 0 1 1 10.34 18" />
    <path d="M7 6h1v4" />
    <path d="m16.71 13.88.7.71-2.82 2.82" />
  </svg>
);

export default AdminDashboard;