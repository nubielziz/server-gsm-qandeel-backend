// English only (decision 039): fails when Arabic script, the `ar` locale or right-to-left layout code comes back into the files of a
// repository, outside a short allowlist. ONE implementation, copied byte for byte into the backend, the website and the console:
// nothing in this file belongs to one repository. What does (roots, allowlist, protected files) is in `english-only.config.json`
// next to it. Plain ESM with Node built-ins only, so it runs under `node` and under `bun`.
// Usage: node scripts/check-english-only.mjs [--root <dir>] [--config <file>] [--skip <path>]...
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only these kinds of file are read (the extension rule). Pictures and fonts hold bytes that look like Arabic code points.
const TEXT = new Set('ts tsx js jsx mjs cjs json sql css md html yml yaml sh svg txt'.split(' '));
const BUILD = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'out']);

// R1: Arabic script. The ranges are written as escapes, so this file holds no Arabic itself.
const ARABIC = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;
// R2: the `ar` locale (case-sensitive: the country code `AR` is fine).
const AR_LOCALE = [
  /(["'`])ar\1/, // a quoted literal: 'ar', "ar", `ar`
  /(?<![\w-])ar[-_][A-Z]{2}\b/, // a tag: ar-JO, ar_JO
  /\blang\s*=\s*\\?["']?ar\b/, // lang="ar", lang=ar
  /:lang\(\s*["']?ar\b/, // :lang(ar)
  /hreflang/i,
  /\blocale=ar\b/,
  /(?:^|[\s"'`([{}=,:^|])\\?\/ar(?=[\\/?#"'`\s()\]}$,;:|]|$)/, // an /ar path literal
  /https?:\/\/[^\s"'`]*\/ar(?=[/?#"'`\s]|$)/, // an /ar path in a URL
];
// R3: right-to-left layout code: a `dir` attribute or prop with the value rtl, in any of its spellings (quoted, unquoted, inside a JSX
// expression, as an object key, through setAttribute). Comparing the direction of a text run (`=== 'rtl'`) and the type
// `'ltr' | 'rtl'` are the PDF shaping of group C and match nothing here.
const RTL = [
  /\bdir\s*=\s*\\?(["'])\s*rtl\s*\\?\1/i, // dir="rtl", dir='rtl', also escaped inside a string
  /(?<![[\w-])dir\s*=\s*rtl\b/i, // dir=rtl (unquoted; the selector [dir=rtl] stays frontend-only)
  /\bdir\s*=\s*\{[^}]*(["'`])rtl\1/i, // dir={'rtl'}, dir={isRtl ? 'rtl' : 'ltr'}
  /\bdir\s*:\s*(["'`])rtl\1/i, // a prop object: { dir: 'rtl' }
  /setAttribute\(\s*(["'`])dir\1\s*,\s*(["'`])rtl\2/i, // el.setAttribute('dir', 'rtl')
];
const RTL_FRONTEND = [
  /\[dir\s*=\s*\\?["']?rtl\b/i, // [dir=rtl], [dir="rtl"], [dir='rtl']
  /:dir\(\s*rtl\s*\)/i,
  /(?:^|[\s"'`{(])(?:[^\s"'`:]+:)*rtl:[^\s"'`:]/, // a Tailwind variant: rtl:ms-2, lg:rtl:ms-2
  /getComputedStyle\s*\([^)]*\)\s*\.\s*direction\b/,
  /getPropertyValue\(\s*["']direction["']/,
];

/** A glob (`*`, `**`, `?`, `[a-z]`, `{a,b}`) as a RegExp over a `/` path. */
function globToRegExp(glob) {
  let re = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      braces++;
      re += '(?:';
    } else if (c === '}' && braces > 0) {
      braces--;
      re += ')';
    } else if (c === ',' && braces > 0) re += '|';
    else if (c === '[' || c === ']') re += c;
    else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** A path entry of the config: a file, a glob, or a folder (everything under it). Returns a test over repository paths. */
function matcher(entry) {
  const own = globToRegExp(entry);
  const below = globToRegExp(`${entry.replace(/\/+$/, '')}/**`);
  return (file) => own.test(file) || below.test(file);
}

function walk(root, dir, out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(join(root, rel)).isDirectory()) {
      if (!BUILD.has(name)) walk(root, rel, out);
    } else out.push(rel);
  }
  return out;
}

/**
 * Every file of the repository, as `/` paths: what git tracks plus new files git does not ignore (so the answer is the same
 * before and after a commit), or a walk that skips `node_modules` and build output when `root` is not a git checkout.
 */
function listFiles(root) {
  let files;
  try {
    const git = (...args) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 1 << 28,
      });
    if (realpathSync(git('rev-parse', '--show-toplevel').trim()) === realpathSync(root))
      files = git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
  } catch {
    /* not a git checkout (or no git): walk */
  }
  files ??= walk(root, '');
  // A file deleted in the working tree can still be listed by git: skip it.
  return [...new Set(files)].filter((f) => existsSync(join(root, f)) && statSync(join(root, f)).isFile());
}

/** A file as text. A byte order mark at its start is not Arabic script (U+FEFF is the last code point of the R1 range). */
function readText(root, file) {
  const text = readFileSync(join(root, file), 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function loadConfig(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const bad = (what) => {
    throw new Error(`${path}: ${what}`);
  };
  if (!Array.isArray(config.roots) || config.roots.length === 0) bad('"roots" must list folders or files');
  for (const key of ['notScanned', 'allow', 'keep']) {
    config[key] ??= [];
    for (const entry of config[key]) {
      if (typeof entry?.path !== 'string' || !entry.path) bad(`an entry of "${key}" has no "path"`);
      if (typeof entry.why !== 'string' || !entry.why.trim())
        bad(`"${key}" entry ${entry.path} has no "why"`);
    }
  }
  return config;
}

function main(argv) {
  const args = { skip: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') args.root = argv[++i];
    else if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--skip') args.skip.push(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  const self = fileURLToPath(import.meta.url);
  const root = resolve(args.root ?? join(dirname(self), '..'));
  const configPath = resolve(args.config ?? join(dirname(self), 'english-only.config.json'));
  const config = loadConfig(configPath);
  const relOf = (abs) => relative(root, abs).split(sep).join('/');
  // The script never reads itself, its config or its own test (they name the patterns).
  const neverRead = (f) =>
    f === relOf(self) || f === relOf(configPath) || /(^|\/)check-english-only\.test\./.test(f);

  const all = listFiles(root);
  const skipped = args.skip.map(matcher);
  const notScanned = config.notScanned.map((e) => matcher(e.path));
  const roots = config.roots.map((r) => r.replace(/\/+$/, ''));
  const scanned = all.filter((f) => {
    const root_ = roots.find((r) => f === r || f.startsWith(`${r}/`));
    if (root_ === undefined || neverRead(f)) return false;
    if (skipped.some((m) => m(f)) || notScanned.some((m) => m(f))) return false;
    return f === root_ || TEXT.has(f.slice(f.lastIndexOf('.') + 1)); // a root named as a file is read whatever its extension
  });

  const problems = [];
  const rtlTests = [...RTL, ...(config.frontend ? RTL_FRONTEND : [])];
  const allowed = config.allow.map((e) => matcher(e.path));
  const triggers = new Set(); // allowed files that still hold Arabic script or the `ar` locale (R4)
  for (const file of scanned) {
    const isAllowed = allowed.some((m) => m(file));
    readText(root, file)
      .split('\n')
      .forEach((line, i) => {
        const hit = ARABIC.test(line)
          ? 'R1 Arabic script'
          : AR_LOCALE.some((t) => t.test(line))
            ? 'R2 the `ar` locale'
            : null;
        if (hit && isAllowed) triggers.add(file);
        const rtl = rtlTests.some((t) => t.test(line));
        if (!isAllowed && (hit || rtl))
          problems.push(`${file}:${i + 1}: ${hit ?? 'R3 right-to-left layout code'}`);
      });
  }

  // R4: every entry of `allow` and `notScanned` must still match a file; a file of `allow` must still trigger R1 or R2.
  const entries = [
    ...config.allow.map((e) => ['allow', e]),
    ...config.notScanned.map((e) => ['notScanned', e]),
  ];
  for (const [kind, entry] of entries) {
    const matches = all.filter(matcher(entry.path));
    if (matches.length === 0) problems.push(`R4 ${kind} entry ${entry.path} matches no file`);
    if (kind === 'allow')
      for (const f of matches.filter((m) => !skipped.some((s) => s(m)) && !triggers.has(m)))
        problems.push(
          `R4 ${f} is allowed but no longer holds Arabic script or the \`ar\` locale (or is not read)`,
        );
  }
  // R5: group C code is still there.
  for (const entry of config.keep) {
    const files = all.filter(matcher(entry.path));
    if (files.length === 0) problems.push(`R5 ${entry.path} is missing (${entry.why})`);
    else if (entry.has && !files.every((f) => readText(root, f).includes(entry.has)))
      problems.push(`R5 ${entry.path} no longer contains ${JSON.stringify(entry.has)} (${entry.why})`);
  }

  if (problems.length > 0) {
    console.error(`english-only: ${problems.length} problem(s)\n${problems.map((p) => `  ${p}`).join('\n')}`);
    return 1;
  }
  console.log(`english-only: ok (${scanned.length} files read)`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`english-only: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 2;
}
