import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useFormat } from '../context/FormatContext';
import ChamaLogo from './ChamaLogo';
import ChangePasswordForm from './ChangePasswordForm';
import LanguagePicker from './LanguagePicker';
import { useI18n } from '../i18n/I18nContext';
import { Menu, LogOut, Shield, ChevronDown, User, KeyRound } from 'lucide-react';

/**
 * Application header: drawer toggle plus the signed-in account menu.
 *
 * The account used to sit in the sidebar footer, which was hard to reach on
 * small screens and got cramped in the collapsed icon rail. It lives here now.
 *
 * `drawerOpen` lets the account menu stand down while the mobile drawer is out.
 * Both are overlays anchored to the same top bar, so leaving them open together
 * put the account menu on top of the drawer with nothing indicating which layer
 * was in front.
 */
const Header = ({ onOpenMenu, portalLabel, drawerOpen = false }) => {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const { chamaName } = useFormat();
  const [open, setOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const ref = useRef(null);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  // Never two menus at once: the drawer and the account menu cannot both be up.
  useEffect(() => {
    if (drawerOpen) setOpen(false);
  }, [drawerOpen]);

  // A dropdown left open across navigation would hang over the new page.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on outside click or Escape, so the menu behaves like a real menu.
  useEffect(() => {
    if (!open) return undefined;

    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const handleLogout = () => {
    setOpen(false);
    logout();
    navigate('/');
  };

  const initials = (user?.full_name || 'TT')
    .split(' ')
    .map((n) => n[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const roleLabel =
    user?.type === 'member'
      ? 'Member'
      : (user?.role || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <header className="app-header">
      <button
        className="icon-btn header-menu"
        onClick={onOpenMenu}
        aria-label="Open menu"
        aria-expanded="false"
      >
        <Menu size={22} />
      </button>

      <div className="header-brand">
        <ChamaLogo size={34} className="header-logo" />
        <span className="header-brand-text">
          <span className="header-brand-name">{chamaName}</span>
          <span className="header-brand-portal">{portalLabel}</span>
        </span>
      </div>

      <div className="header-spacer" />

      <LanguagePicker />

      <div className="user-menu" ref={ref}>
        <button
          className="user-chip"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <span className="user-avatar">{initials}</span>
          <span className="user-chip-text">
            <span className="user-chip-name">{user?.full_name}</span>
            <span className="user-chip-role">{roleLabel}</span>
          </span>
          <ChevronDown size={16} className={`user-chip-caret${open ? ' open' : ''}`} />
        </button>

        {open && (
          <div className="user-dropdown" role="menu">
            <div className="user-dropdown-head">
              <span className="user-avatar user-avatar-lg">{initials}</span>
              <div style={{ minWidth: 0 }}>
                <div className="user-dropdown-name">{user?.full_name}</div>
                <div className="user-dropdown-meta">{user?.email || user?.phone}</div>
              </div>
            </div>

            <div className="user-dropdown-role">
              <Shield size={14} />
              <span>{portalLabel}</span>
            </div>

            <button className="user-dropdown-item" role="menuitem" onClick={() => setOpen(false)}>
              <User size={16} />
              <span>{t('auth.signedInAs', { role: roleLabel })}</span>
            </button>

            {/* Members choose their own password when they register, so there is
                nothing for them to change here. */}
            {user?.type === 'admin' && (
              <button
                className="user-dropdown-item"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  setPasswordOpen(true);
                }}
              >
                <KeyRound size={16} />
                <span>{t('password.menuItem')}</span>
              </button>
            )}

            <button
              className="user-dropdown-item user-dropdown-item--danger"
              role="menuitem"
              onClick={handleLogout}
            >
              <LogOut size={16} />
              <span>{t('common.logout')}</span>
            </button>
          </div>
        )}
      </div>

      {passwordOpen && (
        <div className="modal-overlay" onClick={() => setPasswordOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{t('password.menuItem')}</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setPasswordOpen(false)}
                aria-label={t('common.close')}
              >
                &times;
              </button>
            </div>

            <ChangePasswordForm
              onChanged={() => setPasswordOpen(false)}
              onCancel={() => setPasswordOpen(false)}
            />
          </div>
        </div>
      )}
    </header>
  );
};

export default Header;