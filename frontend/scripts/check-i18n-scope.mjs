/**
 * Finds components that call the translator `t()` without a hook in scope.
 *
 * This is the third time this bug has shipped, always the same shape: a file has
 * several components, the main one gets `const { t } = useI18n()`, and a smaller
 * component in the same file also renders `t('...')` but never asked for the hook.
 * React then throws "t is not a function" and unmounts the whole tree.
 *
 * Checking per FILE cannot catch it, because the file does import and call
 * useI18n. So this walks each component body on its own.
 *
 * Run: node scripts/check-i18n-scope.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = join(here, '..', 'src');

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.jsx$/.test(entry)) out.push(full);
  }
  return out;
};

/**
 * Splits a file into top-level declaration blocks.
 *
 * A JS-aware brace scanner looks like the precise answer and is not. It has to
 * understand that JSX text is not a string literal, that apostrophes appear in
 * prose, and that ${ } nests inside template literals; get any of that wrong and
 * the block silently swallows the component that follows, taking its
 * useI18n() with it and hiding the very bug being looked for. That is exactly
 * what happened here.
 *
 * Using the next declaration as the boundary matches how a person reads the file,
 * cannot over-read, and errs towards reporting rather than silence.
 */
const declarationStarts = (text) => {
  const starts = [];
  /*
   * Leading whitespace is required here. A component moved out of another
   * function keeps its indentation, so "starts at the beginning of a line" is not
   * the same as "starts at the beginning of the file" - and demanding column 0 is
   * exactly what let MpesaStatus through unchecked twice.
   */
  const re = /^[ \t]*(export\s+)?(const|function)\s+([A-Z][\w]*)\s*(=\s*(\([^)]*\)|\w*)\s*=>|=\s*\([^)]*\)\s*=>|\([^)]*\)\s*\{|\w*\s*\{)/gm;

  let m;
  while ((m = re.exec(text)) !== null) {
    starts.push({ name: m[3], index: m.index, decl: m[0] });
  }
  return starts;
};

/** A translator call: t('key') not preceded by a word character or dot. */
const CALLS_TRANSLATOR = /(?<![\w.$])t\(\s*['"`]/;
const HAS_HOOK = /useI18n\s*\(\s*\)/;
// Receives the translator as a prop instead of calling the hook.
const HAS_PROP = /\bt\s*[,}]/;
// Calls the standalone helper rather than the hook.
const HAS_STANDALONE = /\btranslate\s*\(/;

const problems = [];

for (const file of walk(srcDir)) {
  const text = readFileSync(file, 'utf8');
  const rel = relative(srcDir, file).replace(/\\/g, '/');

  /*
   * Indentation is deliberately not used to decide what is "top level".
   *
   * A component moved out of another function keeps its leading spaces, so MpesaStatus
   * sits at indent 2 despite being a sibling of Settings. Skipping indented
   * declarations hid it. A nested helper that renders t() would need its own hook
   * anyway, so checking it too is harmless.
   */
  const decls = declarationStarts(text);

  decls.forEach((decl, index) => {
    const end = index + 1 < decls.length ? decls[index + 1].index : text.length;
    const block = text.slice(decl.index, end);

    if (!CALLS_TRANSLATOR.test(block)) return;
    if (HAS_HOOK.test(block) || HAS_PROP.test(decl.decl) || HAS_STANDALONE.test(block)) return;

    const line = text.slice(0, decl.index).split('\n').length;
    problems.push(`${rel}:${line}  \`${decl.name}\` calls t() but never calls useI18n()`);
  });
}

console.log('=== i18n scope check ===');
if (problems.length === 0) {
  console.log('  every component that calls t() has it in scope');
} else {
  console.log(`  ${problems.length} problem(s):\n`);
  for (const p of problems) console.log('  ' + p);
}
process.exit(problems.length ? 1 : 0);