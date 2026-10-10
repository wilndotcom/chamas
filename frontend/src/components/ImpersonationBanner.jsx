import React from 'react';
import { useAuth } from '../context/AuthContext';
import { Eye, ArrowLeft } from 'lucide-react';

/**
 * Persistent banner shown for the whole time the super admin is viewing the
 * system as somebody else. Prevents acting on the wrong account by mistake.
 */
const ImpersonationBanner = () => {
  const { isImpersonating, user, impersonatedBy, exitImpersonation, loading } = useAuth();

  if (!isImpersonating) return null;

  return (
    <div className="impersonation-banner">
      <div className="impersonation-banner-info">
        <Eye size={18} />
        <div>
          <strong>Viewing as {user?.full_name}</strong>
          <span>
            {user?.type === 'member' ? 'Member portal' : `${user?.role?.replace('_', ' ')} portal`}
            {' · '}opened by {impersonatedBy?.full_name}
          </span>
        </div>
      </div>
      <button className="btn btn-sm btn-exit" onClick={exitImpersonation} disabled={loading}>
        <ArrowLeft size={16} /> Exit &amp; return to Super Admin
      </button>
    </div>
  );
};

export default ImpersonationBanner;