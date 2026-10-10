/**
 * Translation audit.
 *
 * Catches the mistakes that are easy to make by hand and invisible until a user
 * sees them:
 *   - a key present in English but missing in Kiswahili (silently falls back)
 *   - a t('key') call that matches no dictionary entry, so the raw key renders
 *   - {placeholders} that differ between the two languages
 *   - values left identical in both languages, which may be untranslated leftovers
 *   - a dictionary file that does not parse, or whose keys sit at the wrong nesting
 *     level, so nothing resolves even though every line looks like a valid entry
 *
 * Parses line by line to find missing and unused keys, then imports the modules to
 * confirm the files are real JavaScript. The regex parse alone is not trustworthy:
 * it happily reads a file the engine rejects.
 *
 * Run: node scripts/audit-i18n.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(here, '..', 'src');
const rel = (p) => relative(join(srcDir, '..'), p).split('\\').join('/');

/**
 * Reads `'key': 'value'` lines out of a translations file, tracking which
 * language each belongs to.
 *
 * Handles both shapes used here:
 *   dictionaries.js  ->  export const en = { ... }
 *   parts/*.js       ->  export default { en: { ... }, sw: { ... } }
 *
 * Line-based rather than evaluating the module, so this needs no build step and
 * cannot execute project code.
 */
const parseLanguages = (text) => {
  const out = { en: new Map(), sw: new Map() };
  // Two shapes to recognise:
  //   export const en = {        (core dictionary)
  //   export default { en: {     (a part, where en/sw are nested)
  const header = /^\s*(?:export\s+const\s+(en|sw)\s*=\s*\{|([\s]*)(en|sw)\s*:\s*\{\s*$)/;

  /*
   * One entry, either quote style.
   *
   * Both are accepted because a value containing an apostrophe - "Africa's
   * Talking" - is naturally written in double quotes, and a single-quote-only
   * pattern cannot see it. That made this audit report three English translations
   * as missing when they were present and working at runtime, which is the worst
   * failure mode for a check: noise about something that is fine, so the real
   * report gets ignored.
   *
   * Capture order is key, then value. The value is whichever of group 3 (single)
   * or group 4 (double) matched.
   */
  const entry = /^\s*'([\w.]+)'\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/;
  let current = null;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = header.exec(line);
    if (h) {
      current = h[1] || h[3];
      continue;
    }
    if (!current) continue;

    let e = entry.exec(line);
    // A value wrapped onto the next line. Joined rather than skipped: skipping
    // made a perfectly good translation look missing, which is worse than no
    // check at all because it sends you looking for a bug that is not there.
    if (!e) {
      const pending = /^\s*'([\w.]+)'\s*:\s*$/.exec(line);
      if (pending && i + 1 < lines.Length) {
        const cont = /^\s*'((?:[^'\\]|\\.)*)'/.exec(lines[i + 1]);
        if (cont) {
          out[current].set(pending[1], cont[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'));
          i++;
          continue;
        }
      }
      continue;
    }

    const raw = e[2] !== undefined ? e[2] : e[3];
    out[current].set(
      e[1],
      raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    );
  }
  return out;
};

const en = new Map();
const sw = new Map();

const absorb = (parsed) => {
  for (const name of ['en', 'sw']) {
    for (const [k, v] of parsed[name]) {
      // Core vocabulary is loaded last so it wins a collision, matching the
      // spread order in I18nContext.
      if (name === 'en') en.set(k, v);
      else sw.set(k, v);
    }
  }
};

const problems = [];
const note = (kind, msg) => problems.push({ kind, msg });

/*
 * Actually import the dictionaries rather than only parsing them with regex.
 *
 * The regexes below match an entry line by line and are perfectly happy reading
 * a file the JavaScript engine cannot even parse: a missing comma between two
 * entries still produces two "valid looking" matches, so the audit reported full
 * parity on a file that threw SyntaxError the moment the app imported it. Two
 * consecutive dictionary additions were missed this way.
 *
 * Importing is the only check that cannot disagree with the running app.
 */
const dictionaryFiles = [
  join(srcDir, 'i18n', 'parts', 'dashboards.js'),
  join(srcDir, 'i18n', 'parts', 'money.js'),
  join(srcDir, 'i18n', 'parts', 'admin.js'),
  join(srcDir, 'i18n', 'dictionaries.js')
];

let dictionariesLoad = true;
for (const file of dictionaryFiles) {
  try {
    const mod = await import(pathToFileURL(file).href);
    // Two shapes are in use: dictionaries.js exports named `en`/`sw`, the parts
    // export a default `{ en, sw }`. Both must yield two populated objects.
    const en = mod.en ?? mod.default?.en;
    const sw = mod.sw ?? mod.default?.sw;
    if (!en || typeof en !== 'object' || !sw || typeof sw !== 'object') {
      note('dictionary-shape', `${rel(file)} does not expose both an en and a sw object`);
    }
  } catch (error) {
    dictionariesLoad = false;
    note(
      'dictionary-syntax',
      `${rel(file)} does not parse: ${error.message.split('\n')[0]}\n` +
        '    The app cannot import this file, so every key in it would be missing.'
    );
  }
}

for (const part of ['dashboards', 'money', 'admin']) {
  absorb(parseLanguages(readFileSync(join(srcDir, 'i18n', 'parts', `${part}.js`), 'utf8')));
}
absorb(parseLanguages(readFileSync(join(srcDir, 'i18n', 'dictionaries.js'), 'utf8')));

/*
 * Every key must sit inside its language object. The regex parser attributes a
 * line to whichever language block it last saw, so entries written after the
 * closing brace of `en` are counted as English while being unreachable at
 * runtime. Comparing against the imported tables catches that.
 */
if (dictionariesLoad) {
  const core = (await import(pathToFileURL(join(srcDir, 'i18n', 'dictionaries.js')).href)).dictionaries;

  // Merged here rather than by importing parts/index.js: the app relies on Vite to
  // resolve its extensionless imports, and plain Node cannot. Re-implementing the
  // spread keeps this script independent of that bundler behaviour.
  const merged = { en: {}, sw: {} };
  for (const part of ['dashboards', 'money', 'admin']) {
    const mod = (await import(pathToFileURL(join(srcDir, 'i18n', 'parts', `${part}.js`)).href)).default;
    for (const lang of ['en', 'sw']) merged[lang] = { ...merged[lang], ...(mod?.[lang] || {}) };
  }

  for (const lang of ['en', 'sw']) {
    const real = new Set([
      ...Object.keys(merged[lang]),
      ...Object.keys(core[lang] || {})
    ]);
    for (const k of (lang === 'en' ? en.keys() : sw.keys())) {
      if (!real.has(k)) {
        note(
          'unreachable-key',
          `"${k}" is counted as ${lang} but is not inside the ${lang} object, so it ` +
            'would render as a raw key'
        );
      }
    }
  }
}

// English is the source of truth, so it must be at least as large as Kiswahili.
for (const k of sw.keys()) {
  if (!en.has(k)) note('orphan-key', `"${k}" is in sw but not in en`);
}

// Placeholders must line up or text silently loses its value.
const placeholders = (s) => new Set(String(s).match(/\{(\w+)\}/g) || []);
for (const [k, v] of en) {
  if (!sw.has(k)) continue;
  const a = placeholders(v);
  const b = placeholders(sw.get(k));
  if (a.size !== b.size || [...a].some((p) => !b.has(p))) {
    note('placeholder-mismatch', `"${k}" en [${[...a]}] vs sw [${[...b]}]`);
  }
}

// Identical values are either a proper noun or an untranslated leftover. Report
// them for review rather than assuming which.
const suspicious = /^[\sA-Za-z0-9@._/+:'()-]*$/;
const identical = [];
for (const [k, v] of sw) {
  if (v === en.get(k) && !suspicious.test(v)) identical.push(k);
}

// Every t('key') in the source must resolve to something.
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(jsx?|mjs)$/.test(entry)) out.push(full);
  }
  return out;
};

const used = new Map();
const markUsed = (key, file) => {
  if (!used.has(key)) used.set(key, new Set());
  used.get(key).add(file);
};

for (const file of walk(srcDir)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(srcDir, file).replace(/\\/g, '/');

  // Keys passed straight to t().
  for (const m of text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) markUsed(m[1], rel);

  /**
   * Keys chosen by a ternary or held in a lookup map, such as
   * t(n === 1 ? 'dash.attentionOne' : 'dash.attentionMany').
   *
   * Matching only the direct t('...') form reported a large number of working
   * keys as unused, which trains you to ignore the output. Scoped to the
   * translation namespaces so API routes and CSS classes are not picked up.
   */
  const NAMESPACES = [
    'nav', 'members', 'contrib', 'loans', 'cash', 'reports', 'welfare', 'notif',
    'settings', 'roles', 'admins', 'portal', 'dash', 'auth', 'err', 'common',
    'units', 'status', 'footer', 'login', 'logo', 'gateway', 'reg'
  ];
  const shaped = new RegExp(`'((?:${NAMESPACES.join('|')})\\.[\\w.]+)'`, 'g');
  for (const m of text.matchAll(shaped)) markUsed(m[1], rel);
}

for (const [k, files] of used) {
  const where = [...files].join(', ');
  if (!en.has(k)) note('missing-en', `"${k}" used in ${where} has no English text`);
  else if (!sw.has(k)) note('untranslated', `"${k}" used in ${where} has no Kiswahili`);
}

const unused = [...en.keys()].filter((k) => !used.has(k));

// Shadowed translator. The function is named `t`, so a callback parameter also
// called `t` silently replaces it inside that callback. `t.key` then means the
// loop item while `t('key')` is a call, which reads as though both work.
//
// This caused a real crash: a `.map((t) => ...)` over templates contained
// `{t('notif.message')}`, so the translator was invoked as a function and React
// unmounted the tree.
const shadowed = [];
for (const file of walk(srcDir)) {
  if (!/\.jsx$/.test(file)) continue;
  const rel = relative(srcDir, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split('\n');

  const usesTranslator = lines.some((l) => /const\s*\{\s*t[^}]*\}\s*=\s*useI18n\(\)/.test(l));
  if (!usesTranslator) continue;

  for (let i = 0; i < lines.length; i++) {
    // A parameter list that takes a bare `t`: (t) => , (t, x) => , (item = t) ...
    const param = /(\(|,\s*)t\s*(,\s*\w+\s*)*\)\s*=>/.exec(lines[i]);
    if (!param) continue;
    // A module-level helper that takes the translator as an argument is a
    // legitimate use, not shadowing.
    if (/^\s*(?:export\s+)?(?:const|function)\s+\w+\s*=/.test(lines[i]) &&
        /\(\s*t\s*,/.test(lines[i])) continue;

    const indent = lines[i].match(/^\s*/)[0].length;
    // Walk forward to where the callback closes, looking for t( inside it.
    for (let j = i + 1; j < lines.length && j < i + 60; j++) {
      const lineIndent = lines[j].match(/^\s*/)[0].length;
      if (lineIndent <= indent && lines[j].trim() && !/^\s*[)}\];]/.test(lines[j])) break;
      if (/(?<![\w.])t\(/.test(lines[j])) {
        shadowed.push(`${rel}:${j + 1}  \`t\` is shadowed by the callback above: ${lines[j].trim().slice(0, 70)}`);
        break;
      }
    }
  }
}

const out = [];
const say = (s) => out.push(s);

say('=== i18n audit ===');
say(`english keys  : ${en.size}`);
say(`kiswahili keys: ${sw.size}`);
say(`t() call sites: ${used.size}`);
say('');

if (!problems.length) say('no problems found');
else {
  const byKind = {};
  for (const p of problems) (byKind[p.kind] ||= []).push(p.msg);
  for (const [kind, list] of Object.entries(byKind)) {
    say(`${kind} (${list.length}):`);
    for (const m of list.slice(0, 40)) say('  ' + m);
    if (list.length > 40) say(`  ... and ${list.length - 40} more`);
    say('');
  }
}

/**
 * Reported rather than failed on. A shadowed `t` is not always wrong - the
 * callback may never call the translator - but it is the exact shape that caused
 * a crash twice in this codebase, so it is worth a look every time.
 */
say(`shadowed translator - review (${shadowed.length}):`);
for (const s of shadowed.slice(0, 20)) say('  ' + s);
if (shadowed.length > 20) say(`  ... and ${shadowed.length - 20} more`);

say('');

say(`identical in both languages (${identical.length}):`);
for (const k of identical.slice(0, 25)) say(`  ${k} = ${JSON.stringify(sw.get(k))}`);
if (identical.length > 25) say(`  ... and ${identical.length - 25} more`);

say('');
say(`defined but never used (${unused.length}):`);
for (const k of unused.slice(0, 40)) say('  ' + k);
if (unused.length > 40) say(`  ... and ${unused.length - 40} more`);

console.log(out.join('\n'));
process.exit(problems.length ? 1 : 0);