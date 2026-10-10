import React, { useState, useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { adminPath, memberPath } from '../routes';
import { useAuth } from '../context/AuthContext';
import { useFormat } from '../context/FormatContext';
import { useI18n } from '../i18n/I18nContext';
import ChamaLogo from './ChamaLogo';
import {
  LayoutDashboard,
  Users,
  Coins,
  Banknote,
  Heart,
  BarChart3,
  Bell,
  Settings,
  Shield,
  LogOut,
  BookOpen,
  Eye,
  UserCheck,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Download
} from 'lucide-react';
import { canOfferInstall, requestInstallPrompt } from '../pwa';

/**
 * Navigation is defined with translation keys rather than finished words, because
 * these arrays sit outside the component where t() is not yet available. The
 * label is resolved at render time, so switching language re-labels the menu
 * without reloading.
 *
 * `id` is the stable identity for the collapsed set in localStorage. It must not
 * be the label: the label changes with the language, which would reset everyone's
 * collapsed groups the first time they switch.
 */
const ADMIN_GROUPS = [
  {
    id: 'overview',
    labelKey: 'nav.groups.overview',
    items: [{ path: '/', icon: LayoutDashboard, labelKey: 'nav.dashboard' }]
  },
  {
    id: 'members',
    labelKey: 'nav.groups.members',
    items: [
      { path: '/members', icon: Users, labelKey: 'nav.members', permission: 'view_members' },
      { path: '/registrations', icon: UserCheck, labelKey: 'nav.registrations', permission: 'manage_members' }
    ]
  },
  {
    id: 'finance',
    labelKey: 'nav.groups.finance',
    items: [
      { path: '/contributions', icon: Coins, labelKey: 'nav.contributions', permission: 'record_contributions' },
      { path: '/loans', icon: Banknote, labelKey: 'nav.loans', permission: 'view_loans' },
      { path: '/cashbook', icon: BookOpen, labelKey: 'nav.cashbook', permission: 'view_reports' },
      { path: '/reports', icon: BarChart3, labelKey: 'nav.reports', permission: 'view_reports' }
    ]
  },
  {
    id: 'welfare',
    labelKey: 'nav.groups.welfare',
    items: [{ path: '/welfare', icon: Heart, labelKey: 'nav.welfare', permission: 'manage_welfare' }]
  },
  {
    id: 'communication',
    labelKey: 'nav.groups.communication',
    items: [
      { path: '/notifications', icon: Bell, labelKey: 'nav.notifications', permission: 'send_notifications' }
    ]
  },
  {
    id: 'administration',
    labelKey: 'nav.groups.administration',
    items: [
      { path: '/admins', icon: Shield, labelKey: 'nav.admins', permission: 'manage_admins' },
      { path: '/settings', icon: Settings, labelKey: 'nav.settings', permission: 'system_settings' }
    ]
  }
];

/*
 * Shown once the app is actually installed, so the entry is not a dead link for
 * the rest of the group's time with the app.
 */
const INSTALL_ITEM = {
  icon: Download,
  labelKey: 'nav.installApp',
  onClick: () => requestInstallPrompt(),
  // `when` rather than a permission: installing the app is a personal choice about
  // the device in front of you, not an administrative right, so gating it on a role
  // would hide it from a chairman and show it to a treasurer.
  when: canOfferInstall
};

const MEMBER_GROUPS = [
  {
    id: 'overview',
    labelKey: 'nav.groups.overview',
    items: [{ path: '/', icon: LayoutDashboard, labelKey: 'nav.dashboard' }]
  },
  {
    id: 'my-money',
    labelKey: 'nav.groups.myMoney',
    items: [
      { path: '/contributions', icon: Coins, labelKey: 'contrib.myContributions' },
      { path: '/loans', icon: Banknote, labelKey: 'loans.myLoans' }
    ]
  },
  {
    id: 'support',
    labelKey: 'nav.groups.support',
    items: [
      { path: '/welfare', icon: Heart, labelKey: 'nav.welfare' },
      { path: '/notifications', icon: Bell, labelKey: 'nav.notifications' }
    ]
  }
];
const readCollapsedGroups = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem('navCollapsedGroups') || '[]'));
  } catch {
    return new Set();
  }
};

const Sidebar = ({
  open = false,
  onNavigate,
  portalLabel,
  collapsed,
  onToggleCollapse
}) => {
  const { user, logout, hasPermission, isSuperAdmin } = useAuth();
  const { chamaName } = useFormat();
  const { t } = useI18n();
  const navigate = useNavigate();

  const [hiddenGroups, setHiddenGroups] = useState(readCollapsedGroups);

  useEffect(() => {
    try {
      localStorage.setItem('navCollapsedGroups', JSON.stringify([...hiddenGroups]));
    } catch {
      /* storage unavailable: layout choice is not persisted */
    }
  }, [hiddenGroups]);

  const isMember = user?.type === 'member';
  const groups = isMember ? MEMBER_GROUPS : ADMIN_GROUPS;

  // Drop groups the current role cannot see at all, so we never render an
  // empty heading.
  const visibleGroups = groups
    .map((g) => ({
      ...g,
      items: g.items.filter((item) => {
        if (item.superAdminOnly) return isSuperAdmin;
        if (!item.permission) return true;
        return hasPermission(item.permission);
      })
    }))
    .filter((g) => g.items.length > 0);

  // Super admin only, and hidden while already viewing another account.
  if (isSuperAdmin) {
    const admin = visibleGroups.find((g) => g.id === 'administration');
    if (admin) {
      admin.items.push({ path: '/portal-switch', icon: Eye, labelKey: 'nav.portalSwitch' });
    }
  }

  /*
   * Install is offered to both portals, not just the admin one.
   *
   * Members are the ones opening this on a phone most often, and the whole point
   * of the app being installable is that they use it between meetings. A founder
   * installing it and then asking the group to install it leaves the group with
   * nowhere to look.
   */
  if (INSTALL_ITEM.when()) {
    const support = visibleGroups.find((g) => g.id === (isMember ? 'support' : 'administration'));
    if (support) support.items.push(INSTALL_ITEM);
  }

  const toggleGroup = (id) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  return (
    <aside className={`sidebar${open ? ' open' : ''}${collapsed ? ' sidebar--collapsed' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <ChamaLogo size={38} />
          <div className="sidebar-brand-text">
            <h2>{chamaName}</h2>
            <p>{portalLabel}</p>
          </div>
        </div>

        <button
          className="sidebar-collapse"
          onClick={onToggleCollapse}
          aria-label={collapsed ? t('nav.expand') : t('nav.collapse')}
          title={collapsed ? t('nav.expand') : t('nav.collapse')}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      <nav className="sidebar-nav">
        {visibleGroups.map((group) => {
          // In icon-rail mode groups flatten out; there is no room for headings.
          const isHidden = !collapsed && hiddenGroups.has(group.id);

          return (
            <div key={group.id} className="nav-group">
              {!collapsed && (
                <button
                  className={`nav-group-label${isHidden ? ' is-hidden' : ''}`}
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={!isHidden}
                >
                  <span>{t(group.labelKey)}</span>
                  <ChevronDown size={14} />
                </button>
              )}

              {!isHidden &&
                group.items.map((item) =>
                  // An action rather than a link. Installing is a one-off that
                  // opens the sheet and stays put, so navigating away from wherever
                  // the reader was would be a poor trade for it.
                  item.onClick ? (
                    <button
                      key={item.labelKey}
                      type="button"
                      className="nav-link nav-link--action"
                      onClick={item.onClick}
                      title={collapsed ? t(item.labelKey) : undefined}
                    >
                      <item.icon size={19} />
                      <span>{t(item.labelKey)}</span>
                    </button>
                  ) : (
                    <NavLink
                      key={item.path}
                      /*
                       * The group tables above hold bare paths, shared by both
                       * portals. The prefix is applied here, once, so the two
                       * menus stay defined in the same shape and no link can
                       * escape the portal it belongs to.
                       */
                      to={isMember ? memberPath(item.path) : adminPath(item.path)}
                      end={item.path === '/'}
                      onClick={onNavigate}
                      title={collapsed ? t(item.labelKey) : undefined}
                      className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                    >
                      <item.icon size={19} />
                      <span>{t(item.labelKey)}</span>
                    </NavLink>
                  )
                )}
            </div>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <button onClick={handleLogout} title={collapsed ? t('common.logout') : undefined}>
          <LogOut size={19} />
          <span>{t('common.logout')}</span>
        </button>
      </div>
    </aside>
  );
};

export default Sidebar;