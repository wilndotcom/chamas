/*
 * Portal-aware path building.
 *
 * Both portals live on one origin and are told apart by their first path segment
 * (/admin and /member). Every internal link therefore has to carry that prefix,
 * and hard-coding '/admin/members' in twenty places is exactly how half of them
 * end up unprefixed - which sends a member clicking an admin link back to the
 * dashboard with no explanation.
 *
 * These two functions are the only place the prefixes are written. Change them
 * here and every link in the app moves together.
 */

const normalise = (path) => {
  if (!path || path === '/') return '';
  return '/' + String(path).replace(/^\/+/, '');
};

/** A path inside the admin portal. adminPath('members') -> '/admin/members' */
export const adminPath = (path = '') => '/admin' + normalise(path);

/** A path inside the member portal. memberPath('loans') -> '/member/loans' */
export const memberPath = (path = '') => '/member' + normalise(path);

/**
 * The portal a signed-in person belongs on.
 *
 * Used for "go home" links, so the header brand and the sidebar logo land on the
 * dashboard of the portal the reader is actually in rather than bouncing them
 * through a redirect.
 */
export const portalHome = (user) =>
  user?.type === 'member' ? memberPath() : adminPath();

/**
 * Turns a bare page name into a path for whichever portal is in use.
 *
 * The old flat links ('/members', '/loans') are scattered through the pages and
 * in people's bookmarks. Feeding one in returns the prefixed equivalent, which
 * is how those links kept working through the move.
 */
export const portalPath = (user, path = '') =>
  user?.type === 'member' ? memberPath(path) : adminPath(path);