import React, { useState, useEffect } from 'react';
import { useFormat } from '../context/FormatContext';

/**
 * The chama logo, with the built-in mark as a fallback.
 *
 * The image URL is constant, so `logoUpdatedAt` is appended to bust the cache
 * after an upload. If no logo has been set the endpoint answers 404, `onError`
 * fires, and the original gradient mark is drawn instead — so this component
 * always renders something sensible and needs no "does a logo exist?" prop.
 *
 * A chamas logo is usually wide or square rather than perfectly square, so the
 * image is contained inside a square box instead of being stretched or cropped.
 */
const ChamaLogo = ({ size = 38, className = '', rounded = true }) => {
  const { opts } = useFormat();
  const [failed, setFailed] = useState(false);

  // Re-check whenever the settings reload, which happens after a save, so an
  // upload appears without a page refresh.
  useEffect(() => {
    setFailed(false);
  }, [opts.chama_logo_updated_at, opts.chama_name]);

  const box = {
    width: size,
    height: size,
    borderRadius: rounded ? Math.max(6, Math.round(size * 0.24)) : 0,
    flexShrink: 0
  };

  // `chama_has_logo` is only present once the profile has been read. Before
  // that, and when no logo is set, draw the mark directly instead of firing a
  // request that would answer 404 — which would show up as a console error on
  // every single page.
  const known = 'chama_has_logo' in opts;
  const hasLogo = known && opts.chama_has_logo && !failed;

  if (hasLogo) {
    // A STABLE cache-buster. Using Date.now() here would change the src on
    // every render and re-request the image indefinitely.
    const stamp = opts.chama_logo_updated_at || 'none';

    return (
      <span className={`chama-logo ${className}`} style={box}>
        <img
          src={`/api/chama/logo?v=${stamp}`}
          alt=""
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
      </span>
    );
  }

  return (
    <span
      className={`chama-mark ${className}`}
      style={{ ...box, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      TT
    </span>
  );
};

export default ChamaLogo;