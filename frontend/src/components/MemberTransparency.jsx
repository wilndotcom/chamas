import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell
} from 'recharts';
import { Eye, ShieldQuestion } from 'lucide-react';
import { useFormat } from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';

/**
 * What the group holds, shown to members.
 *
 * A chama where members cannot see the books is one where they have to take the
 * treasurer's word for it, which is where suspicion starts. This panel exists so
 * a member can check.
 *
 * The figures are deliberately not collapsed into one "profit" number. Savings and
 * welfare balances are the members' own money held on trust, so adding them to
 * income would tell members their own savings had been earned by the group. Loan
 * interest is the only genuine income, and it is shown on its own.
 */
const MemberTransparency = () => {
  const { t } = useI18n();
  const { money } = useFormat();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showMembers, setShowMembers] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await axios.get('/api/transparency');
      setData(data);
      setFailed(false);
    } catch {
      // Reported as "cannot load" rather than a blank space, so a member is not
      // left wondering whether the group has no figures or the app is broken.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) return null;

  if (failed || !data) {
    return (
      <section className="card" style={{ marginBottom: 20 }}>
        <div className="card-body">
          <p className="text-muted">{t('transp.loadFailed')}</p>
        </div>
      </section>
    );
  }

  const { held_for_members: held, group_position: pos, income, loans, series, members } = data;

  // Only members who have actually contributed or borrowed earn a row here. A
  // list of 40 names all reading zero tells a member nothing and buries the
  // handful that are actually behind.
  const active = (members || []).filter(
    (m) => Number(m.savings_total) > 0 || Number(m.welfare_total) > 0 || Number(m.loan_balance) > 0
  );

  return (
    <section className="card" style={{ marginBottom: 20 }}>
      <div className="card-body">
        <div className="card-head">
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Eye size={18} /> {t('transp.title')}
          </h2>
        </div>

        {/* What belongs to the members. First, because it is the number that is
            theirs, and the one most easily mistaken for the group's money. */}
        <div className="stat-grid" style={{ marginBottom: 18 }}>
          <div className="stat-card">
            <span className="stat-label">{t('transp.savingsHeld')}</span>
            <span className="stat-value">{money(held.savings)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">{t('transp.welfareHeld')}</span>
            <span className="stat-value">{money(held.welfare)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">{t('transp.heldTotal')}</span>
            <span className="stat-value">{money(held.total)}</span>
          </div>
        </div>

        <p className="text-muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 18 }}>
          {pos.note}
        </p>

        {/* What the group itself holds. */}
        <div className="stat-grid" style={{ marginBottom: 18 }}>
          <div className="stat-card">
            <span className="stat-label">{t('transp.cashOnHand')}</span>
            <span className="stat-value">{money(pos.cash_on_hand)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">{t('transp.receivable')}</span>
            <span className="stat-value">{money(pos.receivable_from_members)}</span>
          </div>
          <div className="stat-card stat-card--primary">
            <span className="stat-label">{t('transp.netWorth')}</span>
            <span className="stat-value">{money(pos.net_worth)}</span>
          </div>
        </div>

        {/* Income, kept apart from the money above. */}
        <div className="stat-grid" style={{ marginBottom: 8 }}>
          <div className="stat-card">
            <span className="stat-label">{t('transp.interestCollected')}</span>
            <span className="stat-value">{money(income.interest_collected)}</span>
          </div>
          <div className="stat-card">
            <span className="stat-label">{t('transp.runningCosts')}</span>
            <span className="stat-value">{money(income.expenses)}</span>
          </div>
          <div className="stat-card stat-card--primary">
            <span className="stat-label">{t('transp.profit')}</span>
            <span className="stat-value">{money(income.profit)}</span>
          </div>
        </div>
        <p className="text-muted" style={{ fontSize: 13, marginBottom: 20 }}>{income.note}</p>

        {/* Twelve months, so a member can see the trend rather than one figure. */}
        <h3 style={{ fontSize: 15, marginBottom: 8 }}>{t('transp.lastTwelve')}</h3>
        <div className="chart-box" style={{ height: 240, marginBottom: 20 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={series} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="var(--text-muted)" />
              <YAxis tick={{ fontSize: 11 }} stroke="var(--text-muted)" />
              <Tooltip
                formatter={(v) => money(v)}
                contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8 }}
              />
              <Bar dataKey="savings_in" name={t('transp.savingsHeld')} fill="var(--brand)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="welfare_in" name={t('transp.welfareHeld')} fill="var(--accent)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="interest_earned" name={t('transp.interestCollected')} fill="var(--success, #16a34a)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Who is contributing and who owes. Collapsed by default so the dashboard
            is not a wall of names, but one tap away because a member will ask. */}
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setShowMembers((v) => !v)}
          aria-expanded={showMembers}
        >
          {showMembers ? t('transp.hideMembers') : t('transp.showMembers', { count: active.length })}
        </button>

        {showMembers && (
          <div className="table-container" style={{ marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>{t('transp.member')}</th>
                  <th>{t('transp.savingsHeld')}</th>
                  <th>{t('transp.welfareHeld')}</th>
                  <th>{t('transp.loanBalance')}</th>
                </tr>
              </thead>
              <tbody>
                {active.length === 0 && (
                  <tr><td colSpan={4}>{t('transp.nobodyYet')}</td></tr>
                )}
                {active.map((m) => (
                  <tr key={m.id}>
                    <td>
                      {m.full_name}
                      {m.is_admin === 1 && (
                        <span className="badge badge-info" style={{ marginLeft: 8 }}>
                          <ShieldQuestion size={11} /> {t('transp.alsoAdmin')}
                        </span>
                      )}
                    </td>
                    <td>{money(m.savings_total)}</td>
                    <td>{money(m.welfare_total)}</td>
                    <td>{Number(m.loan_balance) > 0 ? money(m.loan_balance) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
};

export default MemberTransparency;