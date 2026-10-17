/**
 * The password the checks sign in with.
 *
 * It used to be the literal string 'admin123', written into eighteen separate
 * check scripts. That made a working login for the live chama part of the
 * published source: anybody reading the repository knew how to sign in to the
 * running app, and the app is reachable from the internet through a tunnel
 * while a payment is being tested.
 *
 * The checks still need a password to run, so it is read from the one place
 * that is deliberately not published - backend/.env, which is in .gitignore.
 * The environment is checked first, so a single run can be pointed at a
 * different account without editing the file:
 *
 *   ADMIN_PASSWORD=... node backend-php/check-till.mjs
 *
 * The password is not defaulted to anything. A fallback would put the problem
 * straight back: it would be in this file, and this file is published.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ENV_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'backend',
  '.env'
);

/**
 * Reads one key out of a .env file.
 *
 * Hand-written rather than pulling in dotenv, because these checks are run
 * from a folder that has its own dependencies and adding one for a single
 * value is not worth the coupling.
 *
 * Returns null rather than throwing when the file is missing, so the caller
 * can tell "no file" and "no key" apart from "empty value" - the first two
 * want the same complaint, the third wants to be treated as unset.
 */
function readFromEnvFile(name) {
  let text;

  try {
    text = readFileSync(ENV_FILE, 'utf8');
  } catch {
    return null;
  }

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);

    if (!match || match[1] !== name) {
      continue;
    }

    let value = match[2].trim();

    // A matching pair of quotes is how a .env file carries a value with a
    // space or a '#' in it. Both quote styles are accepted, and the pair has
    // to match, or the quote is part of the password.
    const first = value[0];
    if (
      value.length >= 2 &&
      (first === '"' || first === "'") &&
      value[value.length - 1] === first
    ) {
      value = value.slice(1, -1);
    }

    return value === '' ? null : value;
  }

  return null;
}

const password = process.env.ADMIN_PASSWORD || readFromEnvFile('ADMIN_PASSWORD');

if (!password) {
  console.error(
    '\n' +
      '  No admin password to sign in with.\n' +
      '\n' +
      '  The checks need one, and it is no longer written into the source.\n' +
      '  Put it in backend-php/.env:\n' +
      '\n' +
      '      ADMIN_PASSWORD=...\n' +
      '\n' +
      '  or pass it for one run:\n' +
      '\n' +
      '      ADMIN_PASSWORD=... node ' +
      process.argv[1] +
      '\n'
  );

  // Stopped here on purpose. Carrying on would sign in with undefined and
  // report every check as failing, which reads as a broken server rather
  // than as a missing password.
  process.exit(1);
}

export const ADMIN_PASSWORD = password;
