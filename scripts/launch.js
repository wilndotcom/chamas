/**
 * Starts the backend and frontend together, so nobody has to remember which port
 * hosts the installable build.
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
const backend = join(root, 'backend');

const installMode = process.argv.includes('--install');

const BACKEND_PORT = 5000;
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

/* Colour only when a terminal is watching. Redirected to a file, escape codes
   would be written literally as `[2m` noise in front of every line. */
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
  // Prefix forwarded output so two servers stay readable in one terminal.
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

  // A child exiting on its own means what was asked for is not happening, so the
  // whole launcher stops rather than leaving a half-running system behind.
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
        // /T takes the whole tree: nodemon and Vite each spawn a child, and
        // killing only the parent leaves an orphan holding the port.
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

// Ctrl+C has to reach the children, or the prompt returns while two servers keep
// running invisibly and the ports stay held.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}

/**
 * Resolves once the port answers, or rejects once it has waited long enough.
 *
 * Polling rather than scanning child output: these servers print a lot, and
 * matching log lines would break the moment a message is reworded.
 *
 * Both loopback addresses are tried on every attempt. Vite preview binds to
 * whatever `localhost` resolves to, which on Windows is IPv6 `::1`, while the
 * backend binds to every interface. Polling only 127.0.0.1 therefore hangs
 * forever on the frontend even though the port is plainly listening - the port
 * check and the socket check disagree about what "up" means.
 */
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

  for (const [name, dir] of [
    ['backend', backend],
    ['frontend', frontend]
  ]) {
    if (!existsSync(join(dir, 'node_modules'))) {
      throw new Error(`${name} dependencies are missing. Run: cd ${name} && npm install`);
    }
  }

  /*
 * The backend always runs under nodemon, in both modes.
 *
 * Only the frontend differs between dev and install mode, because only the
 * frontend has the service-worker problem that decides which port serves what.
 * The backend has no such constraint, and running it as a plain `node server.js`
 * meant every controller edit needed a manual restart - during development, at
 * least, that reload is the whole point of having nodemon.
 */
say(paint(C.dim, `  starting the backend on :${BACKEND_PORT}`));
start('api', runNpm(['run', 'dev'], backend), C.green);
await waitForPort(BACKEND_PORT, 'The backend');

  if (installMode) {
    // Built output, because the dev server has no service worker and so cannot be
    // installed. Built here rather than assumed, so a stale dist cannot make the
    // install fail for a reason that has nothing to do with the browser.
    say('');
    say(paint(C.yellow, '  build'));
    say(paint(C.dim, '  building the frontend, this takes a moment'));
    await runNpmToCompletion(['run', 'build'], frontend);
  }

  const script = installMode ? 'preview' : 'dev';
  say('');
  say(paint(C.dim, `  starting the frontend on :${FRONTEND_PORT}`));
  start('app', runNpm(['run', script], frontend), C.cyan);
  await waitForPort(FRONTEND_PORT, 'The frontend');

  const url = `http://localhost:${FRONTEND_PORT}`;

  say('');
  say(`  ${paint(C.green, 'Ready.')}`);
  say(`  ${paint(C.bold, url)}`);
  say('');

  if (installMode) {
    say(paint(C.yellow, '  To put it on your desktop'));
    say(`    1. Open ${url}   ${paint(C.dim, '(not :3000)')}`);
    say('    2. Click "Install App" at the bottom of the left sidebar,');
    say('       or use the install icon in the address bar.');
    say('');
    say(paint(C.dim, '    Installing from :3000 instead does nothing at all. Chrome'));
    say(paint(C.dim, '    refuses to install without a service worker, and the dev'));
    say(paint(C.dim, '    server skips it on purpose.'));
  } else {
    say(paint(C.dim, '    Installing from this build will not work. Run'));
    say(`    ${paint(C.bold, 'npm run install')} ${paint(C.dim, 'for that.')}`);
  }
  say('');
};

main().catch((error) => {
  say('');
  say(`  ${paint(C.red, 'Could not start:')} ${error.message}`);
  say('');
  shutdown(1);
});