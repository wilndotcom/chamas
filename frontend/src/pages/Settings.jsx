import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from 'axios';
import toast from 'react-hot-toast';
import {
  Save, Globe, Palette, Sun, Moon, RotateCcw, CheckCircle, AlertTriangle,
  Building2, CreditCard, Bell, Shield, Info
} from 'lucide-react';
import NotificationTemplates from '../components/NotificationTemplates';
import NotificationChannels from '../components/NotificationChannels';
import LogoPicker from '../components/LogoPicker';
import RolesPermissions from './RolesPermissions';
import PaymentGatewaysPanel from '../components/PaymentGatewaysPanel';
import { Download, Check } from 'lucide-react';
import { isAppInstalled, markInstalled, resetInstallPrompt } from '../pwa';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import {
  DEFAULTS,
  CURRENCIES,
  formatWith,
  useFormat
} from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';

const LOCALISATION_KEYS = [
  'language',
  'currency',
  'currency_symbol',
  'symbol_position',
  'decimal_separator',
  'thousand_separator'
];

/**
 * Settings is split into sections because putting nine of them on one scroll
 * meant finding the one you came for meant scrolling past the other eight.
 *
 * Each tab owns whole cards, never half of one, so every card keeps its own Save
 * button and its own dirty-state hint. That was deliberate when the cards were
 * introduced and is kept here: a tab that mixes two cards' fields would force one
 * Save to cover unrelated things.
 *
 * `superAdminOnly` hides the tab from the rail rather than rendering an empty one,
 * so nobody is offered a section they cannot open.
 */
const SETTINGS_TABS = [
  { id: 'general', labelKey: 'settings.tabGeneral', icon: Building2 },
  { id: 'appearance', labelKey: 'settings.tabAppearance', icon: Palette },
  { id: 'payments', labelKey: 'settings.tabPayments', icon: CreditCard },
  { id: 'notifications', labelKey: 'settings.tabNotifications', icon: Bell },
  { id: 'access', labelKey: 'settings.tabAccess', icon: Shield, superAdminOnly: true },
  { id: 'about', labelKey: 'settings.tabAbout', icon: Info }
];

const SYMBOLS = {
  KES: 'KSh',
  TZS: 'TSh',
  UGX: 'USh',
  USD: '$',
  EUR: '€',
  GBP: '£',
  ZAR: 'R',
  RWF: 'FRw'
};

const LABELS = {
  language: 'Language',
  currency: 'Currency',
  currency_symbol: 'Currency symbol',
  symbol_position: 'Symbol position',
  decimal_separator: 'Decimal separator',
  thousand_separator: 'Thousands separator',
  chama_name: 'Chama name',
  monthly_contribution: 'Monthly contribution',
  loan_interest_rate: 'Loan interest rate',
  loan_duration_months: 'Loan duration',
  max_loan_multiplier: 'Max loan multiplier',
  welfare_contribution: 'Welfare contribution',
  mpesa_paybill: 'M-Pesa paybill',
  mpesa_shortcode: 'M-Pesa shortcode',
  mpesa_consumer_key: 'M-Pesa consumer key',
  mpesa_consumer_secret: 'M-Pesa consumer secret',
  mpesa_passkey: 'M-Pesa passkey',
  email_from: 'Email sender'
};

const defaultSymbolFor = (code) => SYMBOLS[code] || code;

const previewItems = [
  { label: 'Whole amount', value: 1250, kind: 'money' },
  { label: 'With cents', value: 1250.5, kind: 'money' },
  { label: 'Small', value: 99, kind: 'money' },
  { label: 'Large', value: 1234567.89, kind: 'money' },
  { label: 'Percentage', value: 12.5, kind: 'percent' }
];

const Settings = () => {
  const { hasPermission, isSuperAdmin } = useAuth();
  const { t, setLanguage, languages, accountLanguage } = useI18n();
  const {
    theme,
    mode,
    themes: themeList,
    setTheme,
    setMode,
    setShared,
    useShared,
    isOverridden
  } = useTheme();
  const { reload } = useFormat();

  // Only someone who can send notifications has anything to edit here.
  const hasTemplates = hasPermission('send_notifications');
  // Setting the look for everyone is a system-level decision.
  const canShare = hasPermission('system_settings');
  // Roles & Rights was its own admin menu entry; it belongs with the rest of configuration.
  const [savingTheme, setSavingTheme] = useState(false);
  const themeOverridden = isOverridden();

  const handleSetTheme = (id) => setTheme(id);
  const handleSetMode = (next) => setMode(next);

  const handleShareTheme = async () => {
    setSavingTheme(true);
    try {
      const a = await setShared('theme', theme);
      const b = await setShared('color_mode', mode);
      if (a.success && b.success) toast.success(t('settings.sharedSaved'));
      else toast.error(a.error || b.error || 'Failed to save');
    } finally {
      setSavingTheme(false);
    }
  };

  const handleUseShared = async () => {
    await useShared();
    toast.success(t('settings.nowShared'));
  };

  const [settings, setSettings] = useState([]);
  const [saving, setSaving] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({});
  // Last values the server confirmed. Comparing against these is what lets a
  // card say "you have unsaved changes" instead of failing silently.
  const [saved, setSaved] = useState({});

  // The account's own language comes from I18nContext, which has already fetched it.
// Fetching it again here was a second identical request on every Settings load.

// Install state for the phone app. The sheet handles the automatic request;
// this gives someone on a desktop browser, or who dismissed the sheet, a way to
// reach it deliberately.
const [installed, setInstalled] = useState(() => isAppInstalled());
const [askAgain, setAskAgain] = useState(false);

const confirmInstalled = () => {
  markInstalled();
  setInstalled(true);
  toast.success(t('settings.appInstalled'));
};

const offerAgain = () => {
  // Clearing the flags lets the sheet ask on the next load. Used when someone
  // dismissed it by accident.
  resetInstallPrompt();
  setAskAgain(false);
  window.location.reload();
};

const onMyLanguageChange = async (value) => {
  const next = value === 'default' ? null : value;
  // setLanguage applies the change immediately, so the page re-labels before the
  // save round-trips, and reports its own failure message.
  const result = await setLanguage(next);
  if (!result.success && result.error) toast.error(result.error);
};

  useEffect(() => {
    fetchSettings();
  }, []);

  // Bumped on every successful save so panels that verify against the API
  // (M-Pesa) re-check themselves. Without it a save can succeed and the panel
  // keeps showing the previous answer.
  const [savedAt, setSavedAt] = useState(0);

  const fetchSettings = async () => {
    try {
      const response = await axios.get('/api/settings');
      setSettings(response.data.settings);
      const formObj = {};
      response.data.settings.forEach(s => {
        formObj[s.setting_key] = s.setting_value;
      });
      setForm(formObj);
      setSaved(formObj);
    } catch (error) {
      toast.error(t('err.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  /** Fields on the General card. */
  const GENERAL_KEYS = [
    'chama_name',
    'monthly_contribution',
    'loan_interest_rate',
    'loan_duration_months',
    'max_loan_multiplier'
  ];

  /**
   * Welfare fund rules (migration 016).
   *
   * A separate save group from the general finance figures, because these are
   * committee decisions about the fund rather than the group's lending terms.
   */
  const WELFARE_RULE_KEYS = [
    'welfare_enabled',
    'welfare_contribution',
    'welfare_allow_self_contribution',
    'welfare_request_needs_approval',
    'welfare_max_request_amount',
    'welfare_min_months_contributed'
  ];

  const AIRTEL_KEYS = [
  'airtel_environment',
  'airtel_api_key',
  'airtel_api_password',
  'airtel_api_username',
  'airtel_merchant_id',
  'airtel_service_provider_id'
];

const MPESA_KEYS = [
    'mpesa_environment',
    'mpesa_callback_url',
    'mpesa_paybill',
    'mpesa_shortcode',
    'mpesa_consumer_key',
    'mpesa_consumer_secret',
    'mpesa_passkey'
  ];

  /*
 * Removed: the standalone "Email sender" card.
 *
 * Its only two keys were `email_from` and `sms_api_key`, and neither was read by
 * utils/notifier.js - every credential came from process.env. Both now belong to
 * the per-channel cards, which is where the dispatcher actually looks.
 */

  /**
   * Save row for a whole card. Disabled until something actually changes, so a
   * click either saves or is visibly unavailable — never silently ignored.
   *
   * A plain render helper rather than a nested component: defining a component
   * inside the parent recreates its type on every render, so React unmounts and
   * remounts it each time.
   */
  const saveRow = (keys, label, className = 'btn btn-primary') => {
    const changed = changedIn(keys);
    const busy = saving === label;

    return (
      <div className="card-save-row">
        <button
          type="button"
          className={className}
          onClick={() => saveCard(keys, label)}
          disabled={busy || changed.length === 0}
        >
          <Save size={18} /> {busy ? 'Saving…' : `Save ${label}`}
        </button>
        <span className={`card-save-hint${changed.length ? ' dirty' : ''}`}>
          {changed.length === 0
            ? 'No changes yet'
            : `Unsaved: ${changed.map((k) => LABELS[k] || k).join(', ')}`}
        </span>
      </div>
    );
  };

  /**
   * Saves every field in a card with one request.
   *
   * Previously each card had a button that wrote a single hardcoded key —
   * "Save General Settings" persisted only the chama name, and the localisation
   * card rendered six identical Save buttons, one per hidden key. Fields looked
   * saved and were not.
   */
  const saveCard = async (keys, label) => {
    const values = {};
    keys.forEach((k) => {
      values[k] = form[k] ?? '';
    });

    setSaving(label);
    try {
      await axios.put('/api/settings', { values });
      toast.success(`${label} saved`);
      setSavedAt((n) => n + 1);
      await fetchSettings();
    } catch (error) {
      toast.error(error.response?.data?.error || `Could not save ${label.toLowerCase()}`);
    } finally {
      setSaving(null);
    }
  };

  // Which keys in this card differ from what the server last gave us.
  const changedIn = (keys) => keys.filter((k) => {
    const now = form[k] ?? '';
    const then = saved[k] ?? '';
    return String(now) !== String(then);
  });

  const previewFormatter = () =>
    formatWith({
      ...DEFAULTS,
      language: form.language,
      currency: form.currency,
      currency_symbol: form.currency_symbol,
      symbol_position: form.symbol_position,
      decimal_separator: form.decimal_separator,
      thousand_separator: form.thousand_separator === 'none' ? '' : form.thousand_separator
    });

  const preview = (item) => {
    const f = previewFormatter();
    return item.kind === 'percent' ? f.percent(item.value) : f.money(item.value);
  };

  // Active section, kept in the query string so a link or a bookmark lands on the
  // right tab and the browser Back button moves between sections.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');

  // The rail only lists sections this account can actually open. Computed before
  // the fallback so an unknown or forbidden ?tab= cannot render an empty panel.
  const tabs = useMemo(
    () => SETTINGS_TABS.filter((tab) => !tab.superAdminOnly || isSuperAdmin),
    [isSuperAdmin]
  );

  const activeTab = tabs.some((tab) => tab.id === requestedTab)
    ? requestedTab
    : tabs[0].id;

  const setActiveTab = (id) => {
    // replace: moving between sections is navigation within one page, and pushing
    // would fill the Back history with every tab clicked.
    setSearchParams({ tab: id }, { replace: true });
  };

  if (loading) {
    return <div>{t('common.loading')}</div>;
  }

  // Without system_settings the API returns 403 for the settings this page is
  // built from, so it would otherwise render an empty form with a full rail of
  // sections that cannot work. Say so plainly instead.
  if (!canShare) {
    return (
      <div>
        <h1 style={{ marginBottom: 20, fontSize: 28, fontWeight: 700 }}>{t('settings.title')}</h1>
        <div className="card">
          <div className="notice-strip notice-strip--danger">
            <AlertTriangle size={16} />
            <span>{t('settings.noAccess')}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h1 style={{ marginBottom: 24, fontSize: 28, fontWeight: 700 }}>{t('settings.title')}</h1>

      <div className="settings-shell">
        {/* The rail is also the table of contents: it shows every section that
            exists, so an admin can see there is an Access or Payments tab
            without scrolling to discover it. */}
        <nav className="settings-rail" aria-label={t('settings.title')}>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                className={`settings-rail-item${tab.id === activeTab ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                aria-current={tab.id === activeTab ? 'page' : undefined}
              >
                <Icon size={17} aria-hidden="true" />
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="settings-panel">
          {activeTab === 'general' && (
            <>
              <div className="card">
        <h3 className="card-title" style={{ marginBottom: 20 }}>{t('settings.general')}</h3>
        <LogoPicker reload={reload} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div className="form-group">
            <label>{t('settings.chamaName')}</label>
            <input
              type="text"
              value={form.chama_name || ''}
              onChange={(e) => setForm({ ...form, chama_name: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>{t('settings.monthlyContribution', { cur: form.currency || 'KES' })}</label>
            <input
              type="number"
              value={form.monthly_contribution || ''}
              onChange={(e) => setForm({ ...form, monthly_contribution: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>{t('settings.loanInterestRate')}</label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="100"
              value={form.loan_interest_rate || ''}
              onChange={(e) => setForm({ ...form, loan_interest_rate: e.target.value })}
            />
            <small className="field-hint">
              Flat, charged once on the borrowed amount and included in the total the member
              repays. At 10%, a 1,000 loan is repayable at 1,100. Each loan keeps the rate that
              applied when it was taken.
            </small>
          </div>
          <div className="form-group">
            <label>{t('settings.loanDuration')}</label>
            <input
              type="number"
              step="1"
              min="1"
              max="60"
              value={form.loan_duration_months || ''}
              onChange={(e) => setForm({ ...form, loan_duration_months: e.target.value })}
            />
            <small className="field-hint">{t('settings.loanDurationNote')}</small>
          </div>
          <div className="form-group">
            <label>{t('settings.maxLoanMultiplier')}</label>
            <input
              type="number"
              value={form.max_loan_multiplier || ''}
              onChange={(e) => setForm({ ...form, max_loan_multiplier: e.target.value })}
            />
          </div>
        </div>
        {saveRow(GENERAL_KEYS, t('settings.general'))}

              {/*
                Welfare is configured here rather than left to whatever the fund
                happened to be doing. Without these the fund had no switch, no cap
                and no waiting period, so a member could ask for anything and a
                request sat approved but unpaid.
              */}
              <div className="card" style={{ marginTop: 16 }}>
                <div className="card-header">
                  <h3 className="card-title">{t('settings.welfareRules')}</h3>
                </div>
                <div className="card-body">
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={form.welfare_enabled === '1'}
                      onChange={(e) =>
                        setForm({ ...form, welfare_enabled: e.target.checked ? '1' : '0' })
                      }
                    />
                    <span>{t('settings.welfareEnabled')}</span>
                  </label>
                  <p className="text-muted" style={{ fontSize: 13 }}>
                    {t('settings.welfareEnabledNote')}
                  </p>

                  <div className="form-group">
                    <label>{t('settings.welfareContribution', { cur: form.currency || 'KES' })}</label>
                    <input
                      type="number"
                      value={form.welfare_contribution || ''}
                      onChange={(e) => setForm({ ...form, welfare_contribution: e.target.value })}
                    />
                  </div>

                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={form.welfare_allow_self_contribution === '1'}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          welfare_allow_self_contribution: e.target.checked ? '1' : '0'
                        })
                      }
                    />
                    <span>{t('settings.welfareSelfContribute')}</span>
                  </label>
                  <p className="text-muted" style={{ fontSize: 13 }}>
                    {t('settings.welfareSelfContributeNote')}
                  </p>

                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={form.welfare_request_needs_approval === '1'}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          welfare_request_needs_approval: e.target.checked ? '1' : '0'
                        })
                      }
                    />
                    <span>{t('settings.welfareNeedsApproval')}</span>
                  </label>
                  <p className="text-muted" style={{ fontSize: 13 }}>
                    {t('settings.welfareNeedsApprovalNote')}
                  </p>

                  <div className="form-group">
                    <label>{t('settings.welfareMaxRequest', { cur: form.currency || 'KES' })}</label>
                    <input
                      type="number"
                      value={form.welfare_max_request_amount || ''}
                      onChange={(e) => setForm({ ...form, welfare_max_request_amount: e.target.value })}
                    />
                    <small className="field-hint">{t('settings.welfareMaxRequestHint')}</small>
                  </div>

                  <div className="form-group">
                    <label>{t('settings.welfareMinMonths')}</label>
                    <input
                      type="number"
                      value={form.welfare_min_months_contributed || ''}
                      onChange={(e) => setForm({ ...form, welfare_min_months_contributed: e.target.value })}
                    />
                    <small className="field-hint">{t('settings.welfareMinMonthsHint')}</small>
                  </div>
                </div>
                {saveRow(WELFARE_RULE_KEYS, t('settings.welfareRules'))}
              </div>
              </div>
            </>
          )}

          {activeTab === 'appearance' && (
            <>
      <div className="card">
        <div className="card-header">
          <div>
            <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <Palette size={18} /> {t('settings.appearance')}
            </h3>
            <p className="card-sub">{t('settings.appearanceNote')}</p>
          </div>
          {themeOverridden && (
            <button className="btn btn-sm btn-secondary" onClick={handleUseShared}>
              <RotateCcw size={14} /> {t('settings.useSharedLook')}
            </button>
          )}
        </div>

        <div className="form-group">
          <label>{t('settings.skin')}</label>
          <div className="theme-swatches">
            {themeList.map((t) => (
              <button
                key={t.id}
                className={`theme-swatch${theme === t.id ? ' active' : ''}`}
                onClick={() => handleSetTheme(t.id)}
                title={t.name}
                aria-pressed={theme === t.id}
              >
                <span
                  className="theme-swatch-bar"
                  style={{ background: `linear-gradient(135deg, ${t.brand}, ${t.accent})` }}
                />
                <span className="theme-swatch-side" style={{ background: t.sidebar }} />
                <span className="theme-swatch-body">
                  <span className="theme-swatch-line" style={{ background: t.brand }} />
                  <span className="theme-swatch-line short" style={{ background: t.accent }} />
                </span>
                <span className="theme-swatch-name">{t.name}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>{t('settings.mode')}</label>
          <div className="mode-toggle">
            <button
              className={`mode-btn${mode === 'light' ? ' active' : ''}`}
              onClick={() => handleSetMode('light')}
            >
              <Sun size={16} /> Light
            </button>
            <button
              className={`mode-btn${mode === 'dark' ? ' active' : ''}`}
              onClick={() => handleSetMode('dark')}
            >
              <Moon size={16} /> Dark
            </button>
          </div>
          <small className="field-note">
            {t('settings.localOnly')}
          </small>
        </div>

        {canShare && (
          <div className="theme-share">
            <div className="theme-share-text">
              <strong>{t('settings.sharedLook')}</strong>
              <span>
                {t('settings.sharedLookNote')}
                {themeOverridden && ' ' + t('settings.overridden')}
              </span>
            </div>
            <button
              className="btn btn-primary"
              onClick={handleShareTheme}
              disabled={savingTheme}
            >
              {savingTheme ? t('common.saving') : t('settings.saveForEveryone')}
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <Globe size={18} /> {t('settings.localisationTitle')}
          </h3>
        </div>

        <div className="form-row">
          {/*
            Two separate controls, because they answer different questions.
            "Your language" applies to this one account and is saved immediately.
            "Group default" is the admin's setting for anyone who has not chosen
            for themselves, and needs an explicit save like every other card here.
          */}
          <div className="form-group">
            <label>{t('settings.yourLanguage')}</label>
            <select
              value={accountLanguage || 'default'}
              onChange={(e) => onMyLanguageChange(e.target.value)}
            >
              <option value="default">{t('settings.useGroupDefault')}</option>
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.native}
                </option>
              ))}
            </select>
            <small className="field-note">{t('settings.yourLanguageNote')}</small>
          </div>

          <div className="form-group">
            <label>{t('settings.groupDefault')}</label>
            <select
              value={form.language || 'en'}
              onChange={(e) => setForm({ ...form, language: e.target.value })}
            >
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.native}
                </option>
              ))}
            </select>
            <small className="field-note">{t('settings.groupDefaultNote')}</small>
          </div>

          <div className="form-group">
            <label>{t('settings.currency')}</label>
            <select
              value={form.currency || 'KES'}
              onChange={(e) => {
                const code = e.target.value;
                const match = CURRENCIES.find((c) => c.code === code);
                setForm({
                  ...form,
                  currency: code,
                  currency_symbol: match ? defaultSymbolFor(code) : form.currency_symbol
                });
              }}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>{t('units.currencySymbol')}</label>
            <input
              type="text"
              value={form.currency_symbol ?? ''}
              onChange={(e) => setForm({ ...form, currency_symbol: e.target.value })}
              placeholder="KSh"
            />
            <small className="field-note">{t('settings.currencySymbolNote')}</small>
          </div>

          <div className="form-group">
            <label>{t('units.symbolPosition')}</label>
            <select
              value={form.symbol_position || 'before'}
              onChange={(e) => setForm({ ...form, symbol_position: e.target.value })}
            >
              <option value="before">{t('units.before')}</option>
              <option value="after">{t('units.after')}</option>
            </select>
          </div>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>{t('units.decimalSeparator')}</label>
            <select
              value={form.decimal_separator ?? '.'}
              onChange={(e) => setForm({ ...form, decimal_separator: e.target.value })}
            >
              <option value=".">{t('units.dot')} &nbsp;&nbsp;(1,250.50)</option>
              <option value=",">{t('units.comma')} &nbsp;(1.250,50)</option>
            </select>
          </div>

          <div className="form-group">
            <label>{t('units.thousandSeparator')}</label>
            <select
              value={form.thousand_separator ?? ','}
              onChange={(e) => setForm({ ...form, thousand_separator: e.target.value })}
            >
              <option value=",">{t('units.comma')} &nbsp;&nbsp;(1,250)</option>
              <option value=".">{t('units.dot')} &nbsp;&nbsp;&nbsp;(1.250)</option>
              <option value=" ">{t('units.space')} &nbsp;&nbsp;(1 250)</option>
              <option value="none">{t('units.none')} &nbsp;&nbsp;&nbsp;&nbsp;(1250)</option>
            </select>
          </div>
        </div>

        {/* Live preview so the choice is obvious before saving */}
        <div className="format-preview">
          <div className="format-preview-label">{t('common.preview')}</div>
          <div className="format-preview-row">
            {previewItems.map((item) => (
              <div key={item.label} className="format-preview-item">
                <span>{item.label}</span>
                <strong>{preview(item)}</strong>
              </div>
            ))}
          </div>
        </div>

        {saveRow(LOCALISATION_KEYS, t('settings.localisationTitle'))}
              </div>
            </>
          )}

          {activeTab === 'payments' && (
            <>
      {canShare && <PaymentGatewaysPanel />}

      {canShare && (
        <div className="card">
          <h3 className="card-title" style={{ marginBottom: 4 }}>{t('settings.airtelMoney')}</h3>
          <p className="card-sub" style={{ marginBottom: 16 }}>
            {t('settings.airtelNote')}
          </p>

          <div className="notice-strip notice-strip--danger" style={{ marginBottom: 18 }}>
            <AlertTriangle size={16} />
            <span>{t('settings.airtelNotWired')}</span>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>{t('settings.airtelEnvironment')}</label>
              <select
                value={form.airtel_environment || 'sandbox'}
                onChange={(e) => setForm({ ...form, airtel_environment: e.target.value })}
              >
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </select>
            </div>
            <div className="form-group">
              <label>{t('settings.airtelMerchantId')}</label>
              <input
                type="text"
                value={form.airtel_merchant_id || ''}
                onChange={(e) => setForm({ ...form, airtel_merchant_id: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>{t('settings.airtelServiceProviderId')}</label>
              <input
                type="text"
                value={form.airtel_service_provider_id || ''}
                onChange={(e) => setForm({ ...form, airtel_service_provider_id: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>{t('settings.airtelApiKey')}</label>
              <input
                type="password"
                value={form.airtel_api_key || ''}
                onChange={(e) => setForm({ ...form, airtel_api_key: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>{t('settings.airtelApiPassword')}</label>
              <input
                type="password"
                value={form.airtel_api_password || ''}
                onChange={(e) => setForm({ ...form, airtel_api_password: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label>{t('settings.airtelApiUsername')}</label>
              <input
                type="text"
                value={form.airtel_api_username || ''}
                onChange={(e) => setForm({ ...form, airtel_api_username: e.target.value })}
              />
            </div>
          </div>

          {saveRow(AIRTEL_KEYS, t('settings.airtelMoney'))}
        </div>
      )}

      <div className="card">
        <h3 className="card-title" style={{ marginBottom: 4 }}>{t('settings.mpesa')}</h3>
        <p className="card-sub" style={{ marginBottom: 18 }}>
          {t('settings.mpesaNote')}
        </p>
        <MpesaStatus savedAt={savedAt} />

        {/*
          The environment is chosen before the credentials, deliberately.

          Picking "production" here points every Daraja call at live Safaricom, so
          it must not sit in a grid below four key fields where it reads like just
          another text box. It is a switch between two whole systems.
        */}
        <div className="mpesa-env-switch">
          <span className="mpesa-env-switch-label">{t('settings.mpesaEnvironment')}</span>
          <div className="mpesa-env-options" role="radiogroup" aria-label={t('settings.mpesaEnvironment')}>
            {['sandbox', 'production'].map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={(form.mpesa_environment || 'sandbox') === value}
                className={`mpesa-env-option${
                  (form.mpesa_environment || 'sandbox') === value ? ' active' : ''
                }${value === 'production' ? ' live' : ''}`}
                onClick={() => setForm({ ...form, mpesa_environment: value })}
              >
                <strong>
                  {value === 'sandbox' ? t('settings.envSandbox') : t('settings.envProduction')}
                </strong>
                <span>
                  {value === 'sandbox'
                    ? t('settings.envSandboxHint')
                    : t('settings.envProductionHint')}
                </span>
              </button>
            ))}
          </div>
          <small className="field-hint">{t('settings.mpesaEnvironmentNote')}</small>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          <div className="form-group">
            <label>{t('settings.paybill')}</label>
            <input
              type="text"
              value={form.mpesa_paybill || ''}
              onChange={(e) => setForm({ ...form, mpesa_paybill: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>{t('settings.shortcode')}</label>
            <input
              type="text"
              value={form.mpesa_shortcode || ''}
              onChange={(e) => setForm({ ...form, mpesa_shortcode: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>{t('settings.consumerKey')}</label>
            <input
              type="text"
              value={form.mpesa_consumer_key || ''}
              onChange={(e) => setForm({ ...form, mpesa_consumer_key: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>{t('settings.consumerSecret')}</label>
            <input
              type="password"
              value={form.mpesa_consumer_secret || ''}
              onChange={(e) => setForm({ ...form, mpesa_consumer_secret: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>{t('settings.passkey')}</label>
            <input
              type="password"
              value={form.mpesa_passkey || ''}
              onChange={(e) => setForm({ ...form, mpesa_passkey: e.target.value })}
            />
          </div>
          <div className="form-group">
            <label>{t('settings.callbackUrl')}</label>
            <input
              type="url"
              value={form.mpesa_callback_url || ''}
              onChange={(e) => setForm({ ...form, mpesa_callback_url: e.target.value })}
              placeholder="https://yourchama.co.ke/api/mpesa/callback"
            />
            <small className="field-hint">
              {t('settings.callbackNote')}
              sandbox — the prompt still goes out, but confirmations will not come back. Required
              before going live, and Safaricom cannot reach localhost.
            </small>
          </div>
        </div>
        {saveRow(MPESA_KEYS, t('settings.mpesa'))}
              </div>
            </>
          )}

          {activeTab === 'notifications' && (
            <>
              {/*
                Channels first, templates second.

                Templates decide what gets said, channels decide whether it can be
                delivered. Putting delivery first means a chama whose WhatsApp is
                not set up finds out before editing a template, rather than
                after wondering why nobody received it.

                This replaces a standalone "Email sender" card whose only field was
                `sms_api_key`-adjacent config the dispatcher never read, plus an
                email address it read from .env and nowhere else.
              */}
              <NotificationChannels
                form={form}
                setForm={setForm}
                onSave={saveCard}
                saving={saving}
                saved={saved}
              />

              {hasTemplates && <NotificationTemplates />}
            </>
          )}

          {/*
            Roles & Rights is super-admin only, and the rail hides the tab for
            everyone else. The guard inside is kept as well: the tab list is
            derived from the same flag, but a guard that only exists in one place
            is a guard that eventually gets bypassed.
          */}
          {activeTab === 'access' && isSuperAdmin && <RolesPermissions embedded />}

          {activeTab === 'about' && canShare && (
            <>
              <div className="card">
                <h3 className="card-title" style={{ marginBottom: 4 }}>
                  {t('install.title')}
                </h3>
                <p className="card-sub" style={{ marginBottom: 16 }}>
                  {installed ? t('settings.appInstalledBody') : t('install.body')}
                </p>

                <div className="install-settings-row">
                  {installed ? (
                    <span className="badge badge-success">
                      <Check size={13} /> {t('settings.appInstalled')}
                    </span>
                  ) : (
                    <>
                      <button className="btn btn-secondary" onClick={confirmInstalled}>
                        <Check size={15} /> {t('settings.markInstalled')}
                      </button>
                      <button className="btn btn-secondary" onClick={offerAgain}>
                        {t('settings.askToInstall')}
                      </button>
                    </>
                  )}
                </div>
                <small className="field-note">{t('install.onceOnly')}</small>
              </div>

              <AboutPanel />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Build identity and licence summary.
 *
 * Lets an operator confirm which build they are running and quote an install id
 * in a support request. Nothing here is transmitted anywhere.
 */
/**
   * Shows which M-Pesa credentials the API is actually using.
   *
   * This exists because saving the form used to look inert: the values reached
   * the database but the Daraja calls read the environment file instead. The
   * source badge per field says whether the API is using what was typed here
   * or still falling back to .env.
   */
  const MpesaStatus = ({ savedAt = 0 }) => {
    const [status, setStatus] = useState(null);
    // Its own component, so it needs its own hook. Without it `t` is undefined and
    // React unmounts the whole page rather than failing visibly in one panel.
    const { t } = useI18n();

    const load = async () => {
      try {
        const r = await axios.get('/api/mpesa/status');
        setStatus(r.data);
      } catch (e) {
        setStatus({ error: 'Could not read the M-Pesa configuration.' });
      }
    };

    // Re-checks on mount and again after every successful save, so the panel
    // reports what the API is doing now rather than what it was doing before.
    useEffect(() => {
      load();
    }, [savedAt]);

    if (!status) return null;

    if (status.error) {
      return (
        <div className="mpesa-status error">
          <AlertTriangle size={15} /> {status.error}
        </div>
      );
    }

    const rows = [
      ['Consumer key', status.values.consumer_key, status.source.consumerKey],
      ['Consumer secret', status.values.consumer_secret, status.source.consumerSecret],
      ['Shortcode', status.values.shortcode, status.source.shortcode],
      ['STK passkey', status.values.passkey, status.source.passkey],
      ['Paybill', status.values.paybill, status.source.paybill],
      ['Callback URL', status.callback_url, status.source.callbackUrl]
    ];

    // Shown under the head rather than as another row: these are facts about where
    // the API is pointed, not credentials to edit, and a live endpoint in a list
    // of masked keys is easy to skim past.
    const production = status.environment === 'production';
    const callbackMissing = !status.callback_reachable;

    return (
      <div className={`mpesa-status${status.configured ? ' ok' : ' warn'}`}>
        <div className="mpesa-status-head">
          {status.configured ? (
            <CheckCircle size={16} />
          ) : (
            <AlertTriangle size={16} />
          )}
          <strong>
            {status.configured
              ? 'M-Pesa is configured and in use'
              : 'M-Pesa is not fully configured'}
          </strong>
          <span className="mpesa-env">{status.environment}</span>
          <button type="button" className="btn btn-sm btn-secondary" onClick={load}>
            Re-check
          </button>
        </div>

        {/*
          The live endpoint, named explicitly.

          "production" is a label an operator chose; what matters is that every
          payment prompt now goes to api.safaricom.co.ke against a real shortcode.
          A test prompt on this setting reaches Safaricom's live system, so the
          host is shown rather than left to be inferred.
        */}
        <div className={`mpesa-endpoint${production ? ' is-live' : ''}`}>
          <span className="mpesa-endpoint-label">{t('settings.callingSafaricomAt')}</span>
          <code>{status.base_url || '-'}</code>
          {status.source.environment === 'env' && (
            <span className="mpesa-source env">{t('settings.envFromEnvFile')}</span>
          )}
        </div>

        {/* The combination that costs money, not either half alone. */}
        {production && callbackMissing && (
          <div className="notice-strip notice-strip--danger" style={{ marginTop: 12 }}>
            <AlertTriangle size={15} />
            <span>{t('settings.liveCallbackMissing')}</span>
          </div>
        )}

        <ul className="mpesa-status-list">
          {rows.map(([label, value, source]) => (
            <li key={label}>
              <span className="mpesa-status-label">{label}</span>
              <code>{value || 'not set'}</code>
              <span className={`mpesa-source ${source}`}>
                {source === 'settings' ? 'saved here' : source === 'env' ? 'from .env' : 'unset'}
              </span>
            </li>
          ))}
        </ul>

        <p className="mpesa-status-note">
          {status.configured
            ? 'These are the values the API is calling Safaricom with.'
            : 'Add the consumer key, consumer secret, shortcode and STK passkey below, then save and press Re-check.'}
          {' '}
          {t('settings.envSourceNote', { source: 'from .env' })}
        </p>
      </div>
    );
  };

  const AboutPanel = () => {
  const [about, setAbout] = useState(null);
  // Its own component, so it needs its own hook. Calling t() without this throws
  // and takes the whole page down rather than failing visibly in one card.
  const { t } = useI18n();

  useEffect(() => {
    let alive = true;
    axios
      .get('/api/settings/about')
      .then((r) => {
        if (alive) setAbout(r.data);
      })
      .catch(() => {
        /* the panel is informational; failing to load it must not break Settings */
      });
    return () => {
      alive = false;
    };
  }, []);

  const copyInstallId = async () => {
    if (!about?.install_id) return;
    try {
      await navigator.clipboard.writeText(about.install_id);
      toast.success(t('settings.installIdCopied'));
    } catch {
      toast.error(t('settings.copyFailed'));
    }
  };

  return (
    <div className="card">
      <h3 className="card-title" style={{ marginBottom: 4 }}>
        {t('settings.about')}
      </h3>
      <p className="card-sub" style={{ marginBottom: 18 }}>
        {t('settings.aboutNote')}
      </p>

      {!about ? (
        <p style={{ color: 'var(--text-soft)', fontSize: 14 }}>{t('settings.loadingBuild')}</p>
      ) : (
        <>
          <div className="about-grid">
            <div>
              <span>{t('settings.version')}</span>
              <strong>{about.version}</strong>
            </div>
            <div>
              <span>{t('settings.build')}</span>
              <strong>{about.build}</strong>
            </div>
            <div>
              <span>{t('settings.membersOnFile')}</span>
              <strong>{about.member_count}</strong>
            </div>
            <div>
              <span>{t('settings.licence')}</span>
              <strong>{about.licence}</strong>
            </div>
          </div>

          <div className="about-install">
            <div>
              <span>{t('settings.installId')}</span>
              <code>{about.install_id}</code>
            </div>
            <button className="btn btn-sm btn-secondary" onClick={copyInstallId}>
              {t('common.copy')}
            </button>
          </div>

          <p className="about-disclosure">
            <strong>{t('settings.privacy')}:</strong> {about.reporting_disclosure}
            {about.reporting_configured
              ? ' ' + t('settings.reportingOn')
              : ' ' + t('settings.reportingOff')}
          </p>

          <div className="about-credit">
            <p>
              {t('footer.builtBy')} <strong>Kenneth Ndugi</strong> {t('footer.builtByUnder')} <strong>WILNCOM TECH</strong>
            </p>
            <p>
              {t('settings.licenceBody')}
            </p>
          </div>
        </>
      )}
    </div>
  );
};

export default Settings;
