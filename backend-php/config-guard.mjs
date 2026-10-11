/**
 * Puts live configuration back exactly as it was found.
 *
 * The suites run against the group's real database, because that is the only
 * place worth testing against: a separate test database would be testing a
 * schema nobody uses. The cost is that a suite which writes configuration and
 * does not put it back changes how the running app behaves.
 *
 * That has happened twice, both times silently, and both times to the M-Pesa
 * callback - once by writing an empty value over a real one, once by leaving
 * behind a localhost address. In both cases the next prompt from localhost was
 * refused and it looked like Safaricom or a broken install rather than a test
 * that had tidied up after itself.
 *
 * So the rule is: snapshot before, restore after, restore unconditionally, and
 * restore to what was actually there rather than to something tidier. A test
 * that finds an undeliverable callback leaves it undeliverable; that is not its
 * business to fix.
 */

/** Reads the configuration a suite might disturb. */
export async function snapshotConfig(api, admin) {
  const status = await api(admin, 'GET', '/api/mpesa/status');
  const settings = await api(admin, 'GET', '/api/settings');

  return {
    callback_url: status.body?.callback_url || '',
    till: settings.body?.mpesa_till || '',
    shortcode: status.body?.values?.shortcode || '',
    paybill: status.body?.values?.paybill || '',
    till_verified: status.body?.till_reported_by_safaricom || ''
  };
}

/**
 * Puts everything back.
 *
 * Reports what could not be restored rather than swallowing it: a suite that
 * quietly leaves the app misconfigured is the exact failure this exists to
 * prevent, so it must be loud.
 */
export async function restoreConfig(api, admin, before, onProblem = () => {}) {
  const problems = [];

  if (before.callback_url) {
    const res = await api(admin, 'PUT', '/api/settings',
      { values: { mpesa_callback_url: before.callback_url } });
    if (res.status !== 200) problems.push(`callback could not be restored (${res.status})`);
  }

  if (before.till) {
    const res = await api(admin, 'PUT', '/api/settings',
      { values: { mpesa_till: before.till } });
    if (res.status !== 200) problems.push(`till could not be restored (${res.status})`);
  }

  const after = await api(admin, 'GET', '/api/mpesa/status');

  if (before.shortcode && after.body?.values?.shortcode !== before.shortcode) {
    problems.push(`till is ${after.body?.values?.shortcode}, was ${before.shortcode}`);
  }

  if (before.callback_url && after.body?.callback_url !== before.callback_url) {
    problems.push(`callback is ${after.body?.callback_url}, was ${before.callback_url}`);
  }

  for (const problem of problems) onProblem(problem);

  return problems;
}