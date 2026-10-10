import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';

const AuthContext = createContext();

export const useAuth = () => useContext(AuthContext);

const readStored = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(() => localStorage.getItem('token'));
  const [impersonatedBy, setImpersonatedBy] = useState(() => readStored('impersonatedBy'));
  const [loading, setLoading] = useState(true);
  /*
   * True when the session is still valid but the server could not be reached.
   *
   * Separate from being signed out on purpose. Previously there was no way to
   * express "still signed in, just not talking to the server", so the app picked
   * the only option it had and threw the user out to the login screen.
   */
  const [connectionLost, setConnectionLost] = useState(false);

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    fetchProfile();
  }, [token]);

  /**
   * Whether a failed profile request means the session is genuinely over.
   *
   * Only a rejection of the token itself counts. Everything else - the backend
   * restarting under nodemon, a dropped connection, a 500, a rate limit - is
   * temporary, and treating those as "signed out" is what made people log in
   * again and again: any momentary hiccup silently deleted a valid token and
   * dumped them on the login screen.
   */
  const sessionIsReallyOver = (error) => {
    const status = error?.response?.status;
    // 401 invalid or expired token, 403 deactivated or wrong portal. Both are
    // decisions the server made about this session.
    return status === 401 || status === 403;
  };

  /** Waits, so a restarting server gets a moment rather than being written off. */
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const fetchProfile = async () => {
    // Three attempts. The server restarting takes a few seconds, and one
    // immediate retry always loses that race.
    const attempts = 3;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        // The stored type decides which profile to load, so a page reload during an
        // impersonated member session still resolves correctly.
        const type = localStorage.getItem('userType');
        const { data } =
          type === 'member'
            ? await axios.get('/api/auth/member-profile')
            : await axios.get('/api/auth/profile');

        setUser(type === 'member' ? data.member : data.admin);
        setImpersonatedBy(readStored('impersonatedBy'));
        setConnectionLost(false);
        setLoading(false);

        // Slide the expiry forward while the user is demonstrably active.
        renewSession();
        return;
      } catch (error) {
        if (sessionIsReallyOver(error)) {
          console.warn('Session rejected, signing out:', error.response?.status);
          logout();
          setLoading(false);
          return;
        }

        // Transient. Keep the stored token: if the server comes back, a reload
        // recovers the session without anyone typing a password.
        console.warn(
          `Profile check failed (attempt ${attempt} of ${attempts}), keeping the session:`,
          error?.response?.status || error?.message
        );

        if (attempt < attempts) {
          await pause(attempt * 800);
          continue;
        }

        // Out of attempts. Stay signed in and say so, rather than bouncing to
        // the login screen and losing the session over a slow server.
        setConnectionLost(true);
        setLoading(false);
      }
    }
  };

  /**
   * Exchanges the current token for a fresh one, in the background.
   *
   * Failure is ignored on purpose: a failed renewal leaves the existing token
   * working until it expires, which is strictly better than tearing the session
   * down over a request the user never asked for.
   */
  const renewSession = async () => {
    try {
      const current = localStorage.getItem('token');
      if (!current) return;
      const { data } = await axios.post(
        '/api/auth/refresh',
        {},
        { headers: { Authorization: Bearer  } }
      );
      if (!data?.token) return;

      /*
       * Only write back if this tab is still the one holding the session.
       *
       * Two tabs share one localStorage, so a background renewal in one would
       * overwrite a session the other had just started. That is not
       * theoretical: a super admin who opens the app in two tabs and then
       * impersonates a member has the original tab's renewal fire a moment later
       * and write the admin token straight over the impersonated one, silently
       * ending the session they were in the middle of using.
       *
       * If the stored token has moved on, another tab owns the session now and
       * this one gets out of the way rather than fighting it for it.
       */
      if (localStorage.getItem('token') !== current) return;

      localStorage.setItem('token', data.token);
      axios.defaults.headers.common['Authorization'] = Bearer ;
      setToken(data.token);
    } catch {
      // Nothing to do. The current token remains valid until it expires.
    }
  };

  const persist = (newToken, principal, extra = {}) => {
    localStorage.setItem('token', newToken);
    localStorage.setItem('userType', principal.type);
    axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
    setToken(newToken);
    setUser(principal);

    if (extra.impersonatedBy) {
      localStorage.setItem('impersonatedBy', JSON.stringify(extra.impersonatedBy));
      setImpersonatedBy(extra.impersonatedBy);
    }
  };

  // `identifier` may be the admin's username or their email address.
  const login = async (identifier, password) => {
    const { data } = await axios.post('/api/auth/admin-login', { identifier, password });
    clearImpersonation();
    persist(data.token, data.admin);
    return data.admin;
  };

  const memberLogin = async (phone, password) => {
    const { data } = await axios.post('/api/auth/member-login', { phone, password });
    clearImpersonation();
    persist(data.token, data.member);
    return data.member;
  };

  /** Super admin only: open the portal as another member or admin. */
  const impersonate = async (targetType, targetId) => {
    const { data } = await axios.post('/api/auth/impersonate', {
      target_type: targetType,
      target_id: targetId
    });

    // Keep the super admin token so "Exit" needs no password.
    localStorage.setItem('returnToken', data.return_token);
    persist(data.token, data.principal, { impersonatedBy: data.impersonated_by });
    return data.principal;
  };

  /** Return to the super admin session. */
  const exitImpersonation = async () => {
    const returnToken = localStorage.getItem('returnToken');
    if (!returnToken) {
      logout();
      return;
    }

    localStorage.setItem('token', returnToken);
    localStorage.setItem('userType', 'admin');
    localStorage.removeItem('returnToken');
    clearImpersonation();

    axios.defaults.headers.common['Authorization'] = `Bearer ${returnToken}`;
    setToken(returnToken);

    try {
      const { data } = await axios.get('/api/auth/profile');
      setUser(data.admin);
    } catch (error) {
      logout();
    }
  };

  const clearImpersonation = () => {
    localStorage.removeItem('impersonatedBy');
    localStorage.removeItem('returnToken');
    setImpersonatedBy(null);
  };

  const logout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('userType');
    clearImpersonation();
    setToken(null);
    setUser(null);
    delete axios.defaults.headers.common['Authorization'];
  };

  const hasPermission = (permission) => {
    if (!user || user.type !== 'admin') return false;
    if (user.role === 'super_admin') return true;
    return (user.permissions || []).includes(permission);
  };

  const isImpersonating = !!impersonatedBy;
  const isSuperAdmin = user?.type === 'admin' && user?.role === 'super_admin' && !isImpersonating;

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        connectionLost,
        login,
        memberLogin,
        logout,
        hasPermission,
        impersonate,
        exitImpersonation,
        isImpersonating,
        isSuperAdmin,
        impersonatedBy
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};
