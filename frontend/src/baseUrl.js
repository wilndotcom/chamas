/**
 * The one prefix, for the few paths axios cannot reach.
 *
 * Nearly every request in this app goes through axios, and axios prepends its
 * baseURL - the deployment prefix, taken from vite's `base` - to any URL that is
 * not protocol-absolute. That is what lets one line in main.jsx retarget the
 * whole app, so the same source runs at the root of a domain and inside a folder
 * such as /the-team/ without any call site knowing the difference.
 *
 * A handful of places cannot use axios: a raw fetch, and the src of an <img>.
 * Each of those was written with a single leading slash, which the browser
 * resolves against the domain root rather than against the app's folder. So the
 * registration form posted to /api/auth/register while the app was served from
 * /the-team/ - a different application's address. Apache answered with an HTML
 * error page, the form tried to read it as JSON, and registration failed with
 * "Unexpected token '<'", which reads as a backend fault and sends the search to
 * the wrong half of the project.
 *
 * BASE_URL always ends with a slash - vite guarantees it, and the trailing slash
 * is why a sub-path deployment keeps the last segment of every asset URL - so
 * joining here is a concatenation once the leading slash is dropped from the
 * path.
 */
const BASE = import.meta.env.BASE_URL || '/';

export const withBase = (path) => `${BASE}${String(path).replace(/^\/+/, '')}`;

export default withBase;
