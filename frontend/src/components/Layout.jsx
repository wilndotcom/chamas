import React, { useState, useEffect, useCallback } from 'react';
import Sidebar from './Sidebar';
import Header from './Header';
import Footer from './Footer';
import ImpersonationBanner from './ImpersonationBanner';
import { useAuth } from '../context/AuthContext';

// Must match the sidebar drawer breakpoint in index.css.
const DESKTOP_QUERY = '(min-width: 1025px)';

const useMediaQuery = (query) => {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setMatches(e.matches);
    setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
};

/**
 * App shell: topbar + sidebar + page content.
 *
 * Below the desktop breakpoint the sidebar slides in as a drawer.
 * Above it, the sidebar can be collapsed to an icon rail; that choice is
 * remembered so the layout looks the same next time.
 */
const Layout = ({ children }) => {
  const isDesktop = useMediaQuery(DESKTOP_QUERY);
  const [open, setOpen] = useState(false);
  const [preferCollapsed, setPreferCollapsed] = useState(
    () => localStorage.getItem('sidebarCollapsed') === '1'
  );
  const { user } = useAuth();

  useEffect(() => {
    try {
      localStorage.setItem('sidebarCollapsed', preferCollapsed ? '1' : '0');
    } catch {
      /* storage unavailable: layout choice is not persisted */
    }
  }, [preferCollapsed]);

  // Leaving drawer mode should not leave a backdrop or a locked body behind.
  useEffect(() => {
    if (isDesktop && open) setOpen(false);
  }, [isDesktop, open]);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  const onNavigate = useCallback(() => setOpen(false), []);

  // Rail mode only makes sense where there is room for it.
  const collapsed = isDesktop && preferCollapsed;

  const portalLabel =
    user?.type === 'member' ? 'Member Portal' : `${(user?.role || '').replace('_', ' ')} Portal`;

  return (
    <div className={`dashboard-layout${collapsed ? ' is-rail' : ''}`}>
      <Header
        onOpenMenu={() => setOpen(true)}
        portalLabel={portalLabel}
        drawerOpen={open}
      />

      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}

      <Sidebar
        open={open}
        onNavigate={onNavigate}
        portalLabel={portalLabel}
        collapsed={collapsed}
        onToggleCollapse={() => setPreferCollapsed((v) => !v)}
      />

      <main className="main-content">
        <ImpersonationBanner />
        {children}
        <Footer />
      </main>
    </div>
  );
};

export default Layout;