import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import toast from 'react-hot-toast';
import { Plus, CheckCircle, XCircle, Heart, Coins, ShieldAlert } from 'lucide-react';
import { useFormat } from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';
import { useAuth } from '../context/AuthContext';

// Welfare statuses arrive from the API as raw words.
const STATUS_KEY = {
  pending: 'status.pending',
  approved: 'status.approved',
  rejected: 'status.rejected',
  disbursed: 'status.disbursed',
  confirmed: 'status.confirmed'
};

const BADGE = {
  pending: 'warning',
  approved: 'info',
  rejected: 'danger',
  disbursed: 'success',
  confirmed: 'success'
};

/**
 * Welfare, for both portals.
 *
 * One page rather than two, because the two views differ by which records they
 * show rather than by what they do. A member sees only their own contributions
 * and requests and can contribute to the fund; an admin sees everyone's, records
 * contributions on their behalf, and decides requests.
 *
 * This was previously admin-only. The route was already registered for members,
 * so a member who tapped Welfare got two failed requests and an empty screen.
 */
const Welfare = () => {
  const { t } = useI18n();
  const { money, opts: fmt } = useFormat();
  const { user } = useAuth();
  // Admins are members too (migration 016), so the signed-in admin's own member
  // record is one of the legitimate recipients of a welfare contribution.
  const myMemberId = user?.member_id || null;
  const isMember = user?.type === 'member';

  const [contributions, setContributions] = useState([]);
  const [requests, setRequests] = useState([]);
  const [fund, setFund] = useState(null);
  const [mine, setMine] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const [showRequest, setShowRequest] = useState(false);
  const [showContribute, setShowContribute] = useState(false);
  const [activeTab, setActiveTab] = useState('contributions');

  const [requestForm, setRequestForm] = useState({ amount: '', reason: '' });
  const [contributeForm, setContributeForm] = useState({ member_id: '', amount: '', payment_method: 'cash' });

  /*
   * Members and admins hit different endpoints, and the member's own totals are
   * not derivable from the list, so the two are fetched separately. A member
   * never calls the admin endpoints: they would 403, and the resulting error is
   * indistinguishable from a real fault.
   */
  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      if (isMember) {
        const { data } = await axios.get('/api/welfare/my');
        setMine(data);
        setContributions(data.contributions || []);
        setRequests(data.requests || []);
        setFund(data.fund);
      } else {
        const [contribRes, requestsRes] = await Promise.all([
          axios.get('/api/welfare/contributions'),
          axios.get('/api/welfare/requests')
        ]);
        setContributions(contribRes.data.contributions || []);
        setRequests(requestsRes.data.requests || []);
        setFund(contribRes.data.fund || null);
      }
      setLoadError(null);
    } catch (error) {
      setLoadError(error.response?.data?.error || t('welfare.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [isMember, t]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  /* --------------------------------------------------------------- actions --- */

  /*
   * Whether the fund's recorded balance can cover a request.
   *
   * The backend no longer refuses a payment the balance cannot cover. Welfare
   * bookkeeping routinely runs behind the cash actually in the treasurer's hand,
   * and refusing left every request impossible to act on. An admin should still
   * be told first, because approving 3,000 against a fund showing zero is a
   * decision they may not have meant to make blind.
   */
  const wouldBeShort = (amount) =>
    Boolean(fund) && Number(amount) > Number(fund.available);

  const runAction = async (id, action, successKey) => {
    const target = requests.find((r) => String(r.id) === String(id));

    if (target && wouldBeShort(target.amount)) {
      const shortBy = Number(target.amount) - Number(fund.available);
      const proceed = window.confirm(
        t('welfare.fundShortWarning', {
          amount: money(target.amount),
          available: money(fund.available),
          short: money(shortBy)
        })
      );
      if (!proceed) return;
    }

    setBusyId(id);
    try {
      const { data } = await axios.post(`/api/welfare/requests/${id}/${action}`);
      toast.success(t(successKey));

      // The backend reports whether the fund ended up short, so the consequence is
      // stated rather than left for someone to find in the ledger later.
      if (data.underfunded) {
        toast(t('welfare.fundNowShort', { short: money(data.shortfall) }), {
          icon: '!',
          duration: 8000
        });
      }
      // The fund position moves with every decision, so it is refreshed rather
      // than guessed at: a stale balance here is the number members trust most.
      if (data.fund) setFund(data.fund);
      fetchData();
    } catch (error) {
      toast.error(error.response?.data?.error || t('common.operationFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const submitRequest = async (e) => {
    e.preventDefault();
    try {
      const { data } = await axios.post('/api/welfare/requests', requestForm);
      toast.success(t(data.needs_approval ? 'welfare.requestSubmitted' : 'welfare.requestPaid'));
      setShowRequest(false);
      setRequestForm({ amount: '', reason: '' });
      fetchData();
    } catch (error) {
      toast.error(error.response?.data?.error || t('welfare.submitFailed'));
    }
  };

  const submitContribution = async (e) => {
    e.preventDefault();
    try {
      const { data } = await axios.post('/api/welfare/contributions', contributeForm);
      toast.success(t('welfare.contributionRecorded'));
      if (data.fund) setFund(data.fund);
      setShowContribute(false);
      setContributeForm({ member_id: '', amount: '', payment_method: 'cash' });
      fetchData();
    } catch (error) {
      toast.error(error.response?.data?.error || t('welfare.contributionFailed'));
    }
  };

  /* ----------------------------------------------------------------- render --- */

  /*
   * count: true renders as a plain number. Two of these tiles are counts, and
   * passing them through the money formatter printed "Members who have
   * contributed KES 1", which reads as one shilling rather than one person.
   */
  /*
   * Flat tiles, not the gradient ones.
   *
   * The gradient .stat-card is white text on the brand colour, and on a saturated
   * skin like sunset that lands around 3.5:1 - under the 4.5:1 needed for text and
   * unreadable for the small label. It was worse than that here: the gradient
   * referenced a colour variable that did not exist, so the background silently
   * dropped out and left white text on the page itself.
   *
   * stat-card--light is what the dashboards already use for this reason: dark
   * text on a light surface, with the accent carried by a border. Emphasis comes
   * from that border rather than from washing the numbers out.
   */
  const tiles = fund ? [
    { label: t('welfare.fundAvailable'), value: fund.available, lead: true },
    { label: t('welfare.fundIn'), value: fund.total_in },
    { label: t('welfare.fundOut'), value: fund.total_out },
    { label: t('welfare.pendingRequests'), value: fund.pending_requests, count: true, alert: fund.pending_requests > 0 },
    { label: t('welfare.contributors'), value: fund.contributors, count: true }
  ] : [];

  const eligibility = mine?.eligibility;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>{t('welfare.title')}</h1>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-primary" onClick={() => setShowRequest(true)}>
            <Heart size={18} /> {t('welfare.request')}
          </button>
          {/*
            A member contributes to the fund only when the group allows it. The
            button is hidden rather than disabled-with-a-tooltip because a dead
            button invites the question "why?" and gets no answer.
          */}
          {isMember ? (
            mine?.can_contribute && (
              <button className="btn btn-secondary" onClick={() => setShowContribute(true)}>
                <Coins size={18} /> {t('welfare.contribute')}
              </button>
            )
          ) : (
            <button className="btn btn-secondary" onClick={() => setShowContribute(true)}>
              <Plus size={18} /> {t('welfare.recordContribution')}
            </button>
          )}
        </div>
      </div>

      {loadError && (
        <div className="notice-strip notice-strip--danger" style={{ marginBottom: 16 }}>
          <ShieldAlert size={16} /> <span>{loadError}</span>
        </div>
      )}

      {/* What the fund holds. Shown before any table: it is the first question
          anyone has about a welfare fund, for members and admins alike. */}
      {fund && (
        <div className="stat-grid" style={{ marginBottom: 20 }}>
          {tiles.map((tile) => (
            <div
              key={tile.label}
              className={`stat-card stat-card--light${tile.lead ? ' tile-lead' : ''}${tile.alert ? ' tile-alert' : ''}`}
            >
              <span className="stat-label">{tile.label}</span>
              <span className="stat-value">{tile.count ? tile.value : money(tile.value)}</span>
            </div>
          ))}
        </div>
      )}

      {/* A member is told plainly when they cannot ask, and why. */}
      {isMember && eligibility && !eligibility.allowed && (
        <div className="notice-strip" style={{ marginBottom: 16 }}>
          <ShieldAlert size={16} /> <span>{eligibility.reason}</span>
        </div>
      )}

      {isMember && mine && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-body">
            <h3 style={{ marginTop: 0 }}>{t('welfare.yourStanding')}</h3>
            <div className="stat-grid">
              <div className="stat-card stat-card--light">
                <span className="stat-label">{t('welfare.youContributed')}</span>
                <span className="stat-value">{money(mine.totals.contributed_all_time)}</span>
              </div>
              <div className="stat-card stat-card--light">
                <span className="stat-label">{t('welfare.thisMonth')}</span>
                <span className="stat-value">{money(mine.totals.contributed_this_month)}</span>
              </div>
              <div className="stat-card stat-card--light">
                <span className="stat-label">{t('welfare.youReceived')}</span>
                <span className="stat-value">{money(mine.totals.received_all_time)}</span>
              </div>
              <div className="stat-card stat-card--light">
                <span className="stat-label">{t('welfare.usualAmount')}</span>
                <span className="stat-value">{money(mine.totals.usual_amount)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

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
                  {!isMember && <th>{t('contrib.member')}</th>}
                  <th>{t('common.amount')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('common.method')}</th>
                  <th>{t('common.status')}</th>
                </tr>
              </thead>
              <tbody>
                {contributions.length === 0 && (
                  <tr><td colSpan={isMember ? 4 : 5}>{t('welfare.noContributions')}</td></tr>
                )}
                {contributions.map((c) => (
                  <tr key={c.id}>
                    {!isMember && <td>{c.member_name}</td>}
                    <td>{money(c.amount)}</td>
                    <td>{new Date(c.contribution_date).toLocaleDateString()}</td>
                    <td>{c.payment_method}</td>
                    <td>
                      <span className={`badge badge-${BADGE[c.status] || 'warning'}`}>
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
                  {!isMember && <th>{t('contrib.member')}</th>}
                  <th>{t('common.amount')}</th>
                  <th>{t('common.reason')}</th>
                  <th>{t('common.date')}</th>
                  <th>{t('common.status')}</th>
                  {!isMember && <th>{t('common.actions')}</th>}
                </tr>
              </thead>
              <tbody>
                {requests.length === 0 && (
                  <tr><td colSpan={isMember ? 4 : 6}>{t('welfare.noRequests')}</td></tr>
                )}
                {requests.map((r) => (
                  <tr key={r.id}>
                    {!isMember && <td>{r.member_name}</td>}
                    <td>{money(r.amount)}</td>
                    <td>{r.reason}</td>
                    <td>{new Date(r.request_date).toLocaleDateString()}</td>
                    <td>
                      <span className={`badge badge-${BADGE[r.status] || 'warning'}`}>
                        {STATUS_KEY[r.status] ? t(STATUS_KEY[r.status]) : r.status}
                      </span>
                    </td>
                    {!isMember && (
                      <td>
                        {/*
                          Approve and pay out are deliberately two buttons. Approving
                          says the committee agreed; paying out says the cash moved.
                          Showing them as one is how an approved request came to look
                          paid while the money was still in the fund.
                        */}
                        {r.status === 'pending' && (
                          <>
                            <button
                              className="btn btn-sm btn-primary"
                              disabled={busyId === r.id}
                              onClick={() => runAction(r.id, 'approve', 'welfare.requestApproved')}
                              title={t('welfare.approve')}
                            >
                              <CheckCircle size={14} />
                            </button>
                            <button
                              className="btn btn-sm btn-danger"
                              disabled={busyId === r.id}
                              onClick={() => runAction(r.id, 'reject', 'welfare.requestRejected')}
                              style={{ marginLeft: 8 }}
                              title={t('welfare.reject')}
                            >
                              <XCircle size={14} />
                            </button>
                          </>
                        )}
                        {r.status === 'approved' && (
                          <button
                            className="btn btn-sm btn-secondary"
                            disabled={busyId === r.id}
                            onClick={() => runAction(r.id, 'disburse', 'welfare.requestPaid')}
                            title={t('welfare.payOut')}
                          >
                            <Coins size={14} /> {t('welfare.payOut')}
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

      {/* Ask for help. */}
      {showRequest && (
        <div className="modal-overlay" onClick={() => setShowRequest(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('welfare.requestAssistance')}</h2>
              <button className="modal-close" onClick={() => setShowRequest(false)}>&times;</button>
            </div>
            <form onSubmit={submitRequest}>
              <div className="form-group">
                <label>{t('welfare.amountNeeded', { currency: fmt.currency || 'KES' })}</label>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={requestForm.amount}
                  onChange={(e) => setRequestForm({ ...requestForm, amount: e.target.value })}
                  required
                />
                {eligibility?.cap > 0 && (
                  <small className="field-hint">{t('welfare.capIs', { amount: money(eligibility.cap) })}</small>
                )}
              </div>
              <div className="form-group">
                <label>{t('welfare.reasonForRequest')}</label>
                <textarea
                  value={requestForm.reason}
                  onChange={(e) => setRequestForm({ ...requestForm, reason: e.target.value })}
                  rows={4}
                  placeholder={t('welfare.reasonPlaceholder')}
                  required
                />
              </div>
              {isMember && mine?.needs_approval === false && (
                <div className="notice-strip" style={{ marginBottom: 12 }}>
                  <span>{t('welfare.autoApprovedNote')}</span>
                </div>
              )}
              <button type="submit" className="btn btn-primary">
                <Heart size={18} /> {t('welfare.submitRequest')}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Put money into the fund. An admin chooses the member; a member is always
          themselves, so the field is not shown to them at all. */}
      {showContribute && (
        <div className="modal-overlay" onClick={() => setShowContribute(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t(isMember ? 'welfare.contribute' : 'welfare.recordContribution')}</h2>
              <button className="modal-close" onClick={() => setShowContribute(false)}>&times;</button>
            </div>
            <form onSubmit={submitContribution}>
              {isMember ? (
                mine?.totals?.usual_amount > 0 && (
                  <div className="notice-strip" style={{ marginBottom: 12 }}>
                    <span>{t('welfare.usualIs', { amount: money(mine.totals.usual_amount) })}</span>
                  </div>
                )
              ) : (
                <MemberPicker
                  value={contributeForm.member_id}
                  onChange={(v) => setContributeForm({ ...contributeForm, member_id: v })}
                  selfId={myMemberId}
                  selfName={user?.full_name}
                />
              )}
              <div className="form-group">
                <label>{t('common.amount')}</label>
                <input
                  type="number"
                  min="1"
                  step="0.01"
                  value={contributeForm.amount}
                  onChange={(e) => setContributeForm({ ...contributeForm, amount: e.target.value })}
                  required
                />
              </div>
              <div className="form-group">
                <label>{t('common.method')}</label>
                <select
                  value={contributeForm.payment_method}
                  onChange={(e) => setContributeForm({ ...contributeForm, payment_method: e.target.value })}
                >
                  <option value="cash">{t('gateway.methodCash')}</option>
                  <option value="mpesa_stk">{t('gateway.methodMpesaStk')}</option>
                  <option value="mpesa_c2b">{t('gateway.methodMpesaC2b')}</option>
                  <option value="bank">{t('gateway.methodBank')}</option>
                </select>
              </div>
              <button type="submit" className="btn btn-primary">
                <Coins size={18} /> {t('welfare.record')}
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * The member list for an admin's contribution form.
 *
 * The signed-in admin appears in it and is the default. An admin is a member of
 * the chama, so recording their own welfare contribution is the most ordinary
 * thing on this form - it should not require picking somebody else first, which
 * is what made the fund un-contributable by the very people who run it.
 *
 * Loaded on demand rather than on mount, so opening the Welfare screen does not
 * pull every member's record before it is needed.
 */
const MemberPicker = ({ value, onChange, selfId, selfName }) => {
  const { t } = useI18n();
  const [members, setMembers] = useState([]);

  useEffect(() => {
    axios.get('/api/members')
      .then(({ data }) => setMembers(data.members || []))
      .catch(() => setMembers([]));
  }, []);

  // Everyone else, so the signed-in admin's own record cannot appear twice.
  const others = members.filter((m) => String(m.id) !== String(selfId));

  return (
    <div className="form-group">
      <label>{t('contrib.member')}</label>
      <select
        value={value || (selfId ? String(selfId) : '')}
        onChange={(e) => onChange(e.target.value)}
        required
      >
        {/*
          No blank option when the admin has a member record: preselecting them
          means the common case - an admin paying their own welfare - is one click
          and no thinking.
        */}
        {selfId ? (
          <option value={String(selfId)}>
            {selfName || t('welfare.yourself')} {t('transp.alsoAdmin')}
          </option>
        ) : (
          <option value="">{t('welfare.chooseMember')}</option>
        )}
        {others.map((m) => (
          <option key={m.id} value={String(m.id)}>
            {m.full_name} ({m.phone})
          </option>
        ))}
      </select>
      {selfId && (
        <small className="field-hint">{t('welfare.adminsAreMembersHint')}</small>
      )}
    </div>
  );
};

export default Welfare;
