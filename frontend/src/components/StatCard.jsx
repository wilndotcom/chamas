import React from 'react';

const PALETTE = {
  green: ['#16a34a', '#0d9488'],
  blue: ['#2563eb', '#0891b2'],
  orange: ['#f97316', '#ea580c'],
  purple: ['#8b5cf6', '#7c3aed'],
  pink: ['#ec4899', '#db2777'],
  teal: ['#14b8a6', '#0d9488'],
  indigo: ['#6366f1', '#4f46e5'],
  amber: ['#f59e0b', '#ea580c'],
  red: ['#ef4444', '#dc2626'],
  cyan: ['#06b6d4', '#0284c7']
};

/**
 * Stat card.
 *
 * Three presentations, and the difference is about meaning rather than decoration:
 *
 *   hero    One lead figure per screen. Surface-coloured with a coloured edge, and
 *           large enough to read from across the room. Four equal tiles give the
 *           reader nothing to look at first.
 *   light   A supporting figure. Flat and quiet, with colour confined to the icon
 *           so the eye goes to the number.
 *   default A filled gradient tile. Kept for pages where every figure carries the
 *           same weight, and for the one case where the colour *is* the message.
 *
 * `tone` always remains meaningful: the icon and the edge take their colour from
 * it, so a red tile still reads as a warning whether it is filled or flat.
 */
const StatCard = ({
  icon: Icon,
  label,
  value,
  hint,
  trend,
  tone = 'green',
  light = false,
  hero = false
}) => {
  const [c1, c2] = PALETTE[tone] || PALETTE.green;

  const style = {
    '--c1': c1,
    '--c2': c2,
    animationDelay: '0ms'
  };

  const classes = [
    'stat-card',
    light ? 'stat-card--light' : '',
    hero ? 'stat-card--hero' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} style={style}>
      <div className="stat-top">
        <div style={{ minWidth: 0 }}>
          <div className="stat-label">{label}</div>
          <div className="stat-value">{value}</div>
          {hint && (
            <div className="stat-hint">
              {trend === 'up' && <span className="trend-up">↑</span>}
              {trend === 'down' && <span className="trend-down">↓</span>}
              <span>{hint}</span>
            </div>
          )}
        </div>
        {Icon && (
          <div className="stat-icon">
            <Icon size={hero ? 26 : 22} />
          </div>
        )}
      </div>
    </div>
  );
};

/** Small coloured tile used for quick action buttons. */
export const QuickAction = ({ icon: Icon, title, subtitle, tone = 'green', onClick }) => {
  const [c1, c2] = PALETTE[tone] || PALETTE.green;
  return (
    <button className="quick-action" onClick={onClick}>
      <span className="qa-icon" style={{ '--c1': c1, '--c2': c2 }}>
        <Icon size={20} />
      </span>
      <span className="qa-text">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </span>
    </button>
  );
};

export const PALETTE_COLORS = PALETTE;
export default StatCard;