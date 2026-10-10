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

  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    fetchProfile();
  }, [token]);

  const fetchProfile = async () => {
    try {
      // The stored type decides which profile to load, so a page reload during an
      // impersonated member session still resolves correctly.
      const type = localStorage.getItem('userType');
      if (type === 'member') {
        const { data } = await axios.get('/api/auth/member-profile');
        setUser(data.member);
      } else {
        const { data } = await axios.get('/api/auth/profile');
        setUser(data.admin);
      }
      setImpersonatedBy(readStored('impersonatedBy'));
    } catch (error) {
      console.error('Failed to fetch profile:', error);
      logout();
    } finally {
      setLoading(false);
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