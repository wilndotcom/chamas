/**
 * Starts the frontend only. The PHP backend is served by Apache/XAMPP
 * directly and is not started here.
 *
 *   node scripts/launch.js            dev mode, frontend on :3000
 *   node scripts/launch.js --install  install mode, frontend on :4173
 *
 * Why the two modes are not interchangeable: Chrome will only offer to install a
 * PWA when a service worker with a fetch handler is registered, and `vite dev`
 * skips the worker on purpose because a caching worker fights its hot reload.
 * Installing from :3000 therefore fails silently, which is exactly the confusion
 * this script exists to remove. Install mode builds first and serves the built
 * output, where the worker does register.
 *
 * No dependencies on purpose. A launcher that needs `concurrently` installed is a
 * launcher that fails the first time someone clones the repo without it.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(root, 'frontend');

const installMode = process.argv.includes('--install');

const FRONTEND_PORT = installMode ? 4173 : 3000;

const isWindows = process.platform === 'win32';

/*
 * Runs an npm script without a shell.
 *
 * Two Windows problems, both avoided by invoking npm's own CLI entry point with
 * the current Node binary instead of spawning `npm`:
 *
 *   1. `npm` on Windows is a .cmd batch file, and Node refuses to execute one
 *      directly: spawn fails with EINVAL.
 *   2. Adding `shell: true` to work around that breaks on the Node path itself,
 *      because `C:\Program Files\nodejs\node.exe` contains a space and the
 *      command line comes out unquoted.
 *
 * npm always ships its CLI beside the Node binary, so the file is normally right
 * there. The shell fallback is only for unusual layouts such as a Node installed
 * by a version manager that keeps npm elsewhere.
 */
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

const runNpm = (args, cwd, extra = {}) => {
  if (existsSync(npmCli)) {
    return spawn(process.execPath, [npmCli, ...args], { cwd, ...extra });
  }
  return spawn(isWindows ? 'npm.cmd' : 'npm', args, {
    cwd,
    ...(isWindows ? { shell: true } : {}),
    ...extra
  });
};

let shuttingDown = false;

const useColour = process.stdout.isTTY === true;

const C = {
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  red: '\u001b[31m'
};

const paint = (code, text) => (useColour ? `${code}${text}\u001b[0m` : String(text));

const say = (line = '') => process.stdout.write(`${line}\n`);

const childProcesses = [];

const start = (label, child, colour) => {
  const prefix = `${colour}${label.padEnd(6)}${useColour ? '\u001b[0m' : ''} | `;
  const forward = (stream) => (chunk) => {
    const text = chunk.toString().replace(/\r?\n$/, '');
    if (text.trim()) stream.write(`${prefix}${text}\n`);
  };
  child.stdout?.on('data', forward(process.stdout));
  child.stderr?.on('data', forward(process.stderr));

  child.on('error', (error) => {
    say(`${paint(C.red, label)} could not start: ${error.message}`);
    shutdown(1);
  });

  child.on('exit', (code) => {
    if (shuttingDown) return;
    say(`${paint(C.red, label)} stopped unexpectedly (code ${code}).`);
    shutdown(code || 1);
  });

  childProcesses.push(child);
  return child;
};

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  say('');
  say(paint(C.dim, 'Stopping.'));

  for (const child of childProcesses) {
    if (child.exitCode !== null || child.killed) continue;
    try {
      if (isWindows && child.pid) {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore'
        });
      } else {
        child.kill('SIGTERM');
      }
    } catch {
      /* already gone */
    }
  }

  setTimeout(() => process.exit(code), 700);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

const loopbackHosts = ['127.0.0.1', '[::1]'];

const probeOnce = (port, host) =>
  new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: 2500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });

const waitForPort = (port, label, timeoutMs = 90000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();

    const attempt = async () => {
      for (const host of loopbackHosts) {
        if (await probeOnce(port, host)) return resolve();
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`${label} did not start on port ${port} within ${timeoutMs / 1000}s.`));
        return;
      }
      setTimeout(attempt, 500);
    };

    attempt();
  });

const run = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(' ')} exited with code ${code}.`))
    );
  });

/** Runs an npm script to completion, in the foreground, so a failed build stops the launcher. */
const runNpmToCompletion = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = runNpm(args, cwd, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`npm ${args.join(' ')} exited with code ${code}.`))
    );
  });

const main = async () => {
  say('');
  say(paint(C.bold, '  THE TEAM'));
  say(installMode ? paint(C.cyan, '  Install mode') : paint(C.cyan, '  Development mode'));
  say('');

  if (!existsSync(join(frontend, 'node_modules'))) {
    throw new Error('Frontend dependencies are missing. Run: cd frontend && npm install');
  }

  if (installMode) {
    say('');
    say(paint(C.yellow, '  build'));
    say(paint(C.dim, '  building the frontend, this takes a moment'));
    await runNpmToCompletion(['run', 'build'], frontend);
  }

  const script = 'dev';
  say('');
  say(paint(C.dim, `  starting the frontend on :${FRONTEND_PORT}`));
  start('app', runNpm(['run', script], frontend), C.cyan);
  await waitForPort(FRONTEND_PORT, 'The frontend');

  const url = `http://localhost:${FRONTEND_PORT}`;

  say('');
  say(`  ${paint(C.green, 'Ready.')}`);
  say(`  ${paint(C.bold, url + '/admin')}   ${paint(C.dim, 'administrators')}`);
  say(`  ${paint(C.bold, url + '/member')}  ${paint(C.dim, 'members')}`);
  say('');
  say(paint(C.dim, '  The PHP backend is served by Apache/XAMPP directly -'));
  say(paint(C.dim, '  open http://localhost:8080/the-team for the installed app.'));
  say('');
  say(paint(C.yellow, '  To put it on your desktop'));
  say(`    1. Open ${url}/admin`);
  say('    2. Click "Install App" at the bottom of the left sidebar,');
  say('       or use the install icon in the address bar.');
  say('');
  say(paint(C.dim, '    For the XAMPP install, open:'));
  say(paint(C.dim, '      http://localhost:8080/the-team'));
  say('');
  say(paint(C.dim, '    Sign in as admin / admin1234. All four administrator accounts'));
  say(paint(C.dim, '    share this starting password until each chooses their own.'));
  say('');
};

main().catch((error) => {
  say('');
  say(`  ${paint(C.red, 'Could not start:')} ${error.message}`);
  say('');
  shutdown(1);
});
