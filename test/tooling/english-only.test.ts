// The guard of decision 039 (`scripts/check-english-only.mjs`, one script copied byte for byte into the three repositories): each
// rule, the lists, `--skip`, and the wiring in `package.json`. The script runs on a small tree this test writes to a temporary
// folder, with `--root` and `--config`; the Arabic samples are built from code points so that this file holds no Arabic script
// (it is on the guard's `notScanned` list anyway: it names the patterns).
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-english-only.mjs');
/** A word in Arabic script, from code points (U+0645 U+0631 U+062D U+0628 U+0627). */
const ARABIC = String.fromCodePoint(0x645, 0x631, 0x62d, 0x628, 0x627);
/** Arabic presentation forms (U+FEE3, U+FE8E): a range of its own in rule R1. */
const FORMS = String.fromCodePoint(0xfee3, 0xfe8e);

interface Entry {
  readonly path: string;
  readonly why: string;
  readonly has?: string;
}
interface Config {
  readonly roots: string[];
  readonly frontend: boolean;
  readonly notScanned: Entry[];
  readonly allow: Entry[];
  readonly keep: Entry[];
}

const BASE: Config = { roots: ['src', 'scripts'], frontend: false, notScanned: [], allow: [], keep: [] };

let work: string;
let counter = 0;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'gsm-english-only-'));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Writes a tree and a config into a fresh folder and runs the guard on it. */
function guard(files: Record<string, string | Uint8Array>, config: Partial<Config> = {}, args: string[] = []) {
  const dir = join(work, `tree-${(counter += 1)}`);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  const configFile = join(work, `config-${counter}.json`);
  writeFileSync(configFile, JSON.stringify({ ...BASE, ...config }));
  const run = Bun.spawnSync([process.execPath, SCRIPT, '--root', dir, '--config', configFile, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/** The problem lines of a failed run (`file:line: rule`, or `R4 …`), without the header. */
const problems = (run: { err: string }): string[] =>
  run.err
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);

describe('R1: Arabic script', () => {
  it('fails on a letter of the main block, with the file and the line', () => {
    const run = guard({ 'src/a.ts': `const ok = 1;\nconst name = '${ARABIC}';\n` });
    expect(run.code).toBe(1);
    expect(problems(run)).toEqual(['src/a.ts:2: R1 Arabic script']);
  });

  it('fails on presentation forms too, in any text extension that is read', () => {
    for (const ext of [
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'json',
      'sql',
      'css',
      'md',
      'html',
      'yml',
      'yaml',
      'sh',
      'svg',
      'txt',
    ]) {
      const run = guard({ [`src/a.${ext}`]: `x ${FORMS}\n` });
      expect(problems(run), ext).toEqual([`src/a.${ext}:1: R1 Arabic script`]);
    }
  });

  it('passes on English text, a comment that says "Arabic", and Latin-1 and CJK letters', () => {
    const run = guard({
      'src/a.ts': '// Arabic names print on the PDF.\nconst s = "café 中文 ก";\n',
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain('english-only: ok (1 files read)');
  });

  it('does not count a byte order mark as Arabic script', () => {
    expect(guard({ 'src/a.ts': '﻿export const a = 1;\n' }).code).toBe(0);
  });

  it('skips a picture or a font whose bytes decode to Arabic code points (the extension rule)', () => {
    const bytes = new TextEncoder().encode(`${ARABIC}${FORMS}`);
    const run = guard({
      'src/logo.png': bytes,
      'src/fonts/a.ttf': bytes,
      'src/b.jpg': bytes,
      'src/ok.ts': 'export {};\n',
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain('(1 files read)');
  });

  it('reads only the roots: a file outside them may hold Arabic', () => {
    const run = guard({ 'docs/a.md': ARABIC, 'src/ok.ts': 'export {};\n' });
    expect(run.code).toBe(0);
  });

  it('does not read a file named check-english-only.test.*', () => {
    const run = guard({ 'scripts/check-english-only.test.mjs': `// ${ARABIC}\n`, 'src/ok.ts': 'export {};\n' });
    expect(run.code, run.err).toBe(0);
  });

  it('does not read itself or its config, and finds both next to each other by default (no --root, no --config)', () => {
    const dir = join(work, `tree-${(counter += 1)}`);
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'check-english-only.mjs'), `${readFileSync(SCRIPT, 'utf8')}\n// ${ARABIC}\n`);
    writeFileSync(
      join(dir, 'scripts', 'english-only.config.json'),
      JSON.stringify({ ...BASE, allow: [], keep: [], notScanned: [], note: ARABIC }),
    );
    writeFileSync(join(dir, 'src', 'ok.ts'), 'export {};\n');
    const run = Bun.spawnSync([process.execPath, join(dir, 'scripts', 'check-english-only.mjs')], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString()).toContain('english-only: ok (1 files read)');
  });
});

describe('R2: the `ar` locale', () => {
  const FINDINGS = [
    "const l = 'ar';",
    'const l = "ar";',
    'const l = `ar`;',
    '// the tag ar-JO',
    "const tag = 'ar_JO';",
    '<html lang="ar">',
    '<html lang=ar>',
    ':lang(ar) { color: red; }',
    '<link rel="alternate" hreflang="x" />',
    "fetch('/api?locale=ar');",
    "const p = '/ar/services';",
    "const p = '/ar';",
    'fetch("https://shop.example/ar/about");',
  ];
  const FINE = [
    "const country = 'AR';",
    '// The word Arabic in a comment is no finding.',
    "const archive = '/archive/2024';",
    "const area = 'area';",
    "const bar = 'bar';",
    "const p = '/are/x';",
    "const q = 'par';",
    'const tag = "AR-JO";',
    "const l = 'en';",
  ];

  it('flags each spelling, on its own line', () => {
    const run = guard({ 'src/a.ts': FINDINGS.join('\n') });
    expect(problems(run)).toEqual(FINDINGS.map((_line, index) => `src/a.ts:${index + 1}: R2 the \`ar\` locale`));
  });

  it('leaves words and codes that only look alike', () => {
    const run = guard({ 'src/a.ts': FINE.join('\n') });
    expect(run.code, run.err).toBe(0);
  });
});

describe('R3: right-to-left layout code', () => {
  const EVERYWHERE = [
    '<div dir="rtl">',
    "<div dir='rtl'>",
    'const s = "<div dir=\\"rtl\\">";',
    '<div dir=rtl>',
    "<div dir={isRtl ? 'rtl' : 'ltr'}>",
    "const props = { dir: 'rtl' };",
    "el.setAttribute('dir', 'rtl');",
  ];
  const FRONTEND_ONLY = [
    '[dir=rtl] .x { margin: 0; }',
    ':dir(rtl) .y {}',
    '<p className="rtl:ms-2 p-1">',
    'getComputedStyle(el).direction;',
  ];
  const NOT_LAYOUT = [
    "if (run.direction === 'rtl') draw(run);",
    "export type Direction = 'ltr' | 'rtl';",
    'const direction = paragraphDirection(text);',
    '<div dir="ltr" lang="en">',
    '<bdi dir="auto">x</bdi>',
  ];

  it('flags a dir attribute with the value rtl, in every repository', () => {
    const run = guard({ 'src/a.tsx': EVERYWHERE.join('\n') });
    expect(problems(run)).toEqual(
      EVERYWHERE.map((_line, index) => `src/a.tsx:${index + 1}: R3 right-to-left layout code`),
    );
  });

  it('flags the frontend variants only where `frontend` is true', () => {
    const files = { 'src/a.tsx': FRONTEND_ONLY.join('\n') };
    expect(guard(files, { frontend: false }).code).toBe(0);
    const run = guard(files, { frontend: true });
    expect(problems(run)).toEqual(
      FRONTEND_ONLY.map((_line, index) => `src/a.tsx:${index + 1}: R3 right-to-left layout code`),
    );
  });

  it('is no finding to compare the direction of a text run or to name the type (the PDF shaping of group C)', () => {
    const files = { 'src/a.ts': NOT_LAYOUT.join('\n') };
    expect(guard(files, { frontend: false }).code).toBe(0);
    expect(guard(files, { frontend: true }).code).toBe(0);
  });
});

describe('the lists', () => {
  const ARABIC_FILE = { 'src/pdf.spec.ts': `expect(x).toBe('${ARABIC}');\n`, 'src/ok.ts': 'export {};\n' };

  it('allow: a file in the list may hold Arabic text and the `ar` locale', () => {
    const run = guard(ARABIC_FILE, { allow: [{ path: 'src/pdf.spec.ts', why: 'group C' }] });
    expect(run.code, run.err).toBe(0);
    const glob = guard(ARABIC_FILE, { allow: [{ path: 'src/*.spec.ts', why: 'group C' }] });
    expect(glob.code, glob.err).toBe(0);
    const braces = guard(ARABIC_FILE, { allow: [{ path: 'src/{pdf,other}.spec.ts', why: 'group C' }] });
    expect(braces.code, braces.err).toBe(0);
  });

  it('R4: an allow entry that matches no file fails', () => {
    const run = guard(ARABIC_FILE, {
      allow: [
        { path: 'src/pdf.spec.ts', why: 'group C' },
        { path: 'src/gone.spec.ts', why: 'deleted' },
      ],
    });
    expect(problems(run)).toEqual(['R4 allow entry src/gone.spec.ts matches no file']);
  });

  it('R4: a file of an allow entry that no longer holds Arabic script or the `ar` locale fails (a cleanup that strips group C)', () => {
    const run = guard(
      { 'src/pdf.spec.ts': 'expect(x).toBe("plain");\n', 'src/ok.ts': 'export {};\n' },
      { allow: [{ path: 'src/pdf.spec.ts', why: 'group C' }] },
    );
    expect(problems(run)).toEqual([
      'R4 src/pdf.spec.ts is allowed but no longer holds Arabic script or the `ar` locale (or is not read)',
    ]);
  });

  it('R4: a file that holds only a right-to-left finding is not made safe by an allow entry that needs R1 or R2', () => {
    const run = guard({ 'src/a.tsx': '<div dir="rtl">\n' }, { allow: [{ path: 'src/a.tsx', why: 'x' }] });
    expect(problems(run)).toEqual([
      'R4 src/a.tsx is allowed but no longer holds Arabic script or the `ar` locale (or is not read)',
    ]);
  });

  it('notScanned: a file in the list is not read, and an entry that matches nothing fails', () => {
    const files = { 'src/old/0001.sql': `-- ${ARABIC}\n`, 'src/ok.ts': 'export {};\n' };
    expect(guard(files, { notScanned: [{ path: 'src/old', why: 'history' }] }).code).toBe(0);
    const stale = guard(files, {
      notScanned: [
        { path: 'src/old', why: 'history' },
        { path: 'src/new', why: 'x' },
      ],
    });
    expect(problems(stale)).toEqual(['R4 notScanned entry src/new matches no file']);
  });

  it('R5: a keep file that is missing, or no longer contains its text, fails', () => {
    const files = { 'src/shaping.ts': 'export const scriptDirection = 1;\n' };
    const ok = guard(files, { keep: [{ path: 'src/shaping.ts', has: 'scriptDirection', why: 'PDF shaping' }] });
    expect(ok.code, ok.err).toBe(0);
    const lost = guard(files, { keep: [{ path: 'src/shaping.ts', has: 'paragraphDirection', why: 'PDF shaping' }] });
    expect(problems(lost)).toEqual(['R5 src/shaping.ts no longer contains "paragraphDirection" (PDF shaping)']);
    const missing = guard(files, { keep: [{ path: 'src/fonts/a.ttf', why: 'the font' }] });
    expect(problems(missing)).toEqual(['R5 src/fonts/a.ttf is missing (the font)']);
  });

  it('R5: a keep entry with no text only asks that the file is there, and reads no bytes (a font)', () => {
    const run = guard(
      { 'src/fonts/a.ttf': new TextEncoder().encode(ARABIC) },
      { keep: [{ path: 'src/fonts/a.ttf', why: 'the font' }] },
    );
    expect(run.code, run.err).toBe(0);
  });
});

describe('--skip', () => {
  const files = { 'src/gen/a.json': `{"x":"${ARABIC}"}\n`, 'src/b.ts': `const a = '${ARABIC}';\n` };

  it('leaves a path out of one run, and only that path', () => {
    const run = guard(files, {}, ['--skip', 'src/gen']);
    expect(problems(run)).toEqual(['src/b.ts:1: R1 Arabic script']);
    const both = guard(files, {}, ['--skip', 'src/gen', '--skip', 'src/b.ts']);
    expect(both.code, both.err).toBe(0);
  });

  it('is the only way: the same tree without it fails', () => {
    expect(guard(files).code).toBe(1);
  });

  it('is never wired into a package.json script (nothing is committed for it)', () => {
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
    for (const [name, command] of Object.entries(scripts)) expect(command, name).not.toContain('--skip');
  });
});

describe('the configuration and the arguments', () => {
  it('refuses an entry with no "why", empty roots and an unknown argument (exit 2)', () => {
    const noWhy = guard({ 'src/a.ts': 'export {};\n' }, { allow: [{ path: 'src/a.ts', why: ' ' }] });
    expect(noWhy.code).toBe(2);
    expect(noWhy.err).toContain('has no "why"');
    const noRoots = guard({ 'src/a.ts': 'export {};\n' }, { roots: [] });
    expect(noRoots.code).toBe(2);
    const unknown = guard({ 'src/a.ts': 'export {};\n' }, {}, ['--nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Unknown argument');
  });

  it('a root can be a single file, read whatever its extension', () => {
    const run = guard(
      { 'compose.yaml': 'a: 1\n', Dockerfile: `# ${ARABIC}\n` },
      { roots: ['compose.yaml', 'Dockerfile'] },
    );
    expect(problems(run)).toEqual(['Dockerfile:1: R1 Arabic script']);
  });
});

describe('this repository', () => {
  const config = JSON.parse(readFileSync(join(ROOT, 'scripts', 'english-only.config.json'), 'utf8')) as Config;
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;

  it('runs the guard as `english:check`, inside `check`, right after `format:check`', () => {
    expect(scripts['english:check']).toBe('bun scripts/check-english-only.mjs');
    expect(scripts['check']).toContain('bun run format:check && bun run english:check && bun run routes:check');
  });

  it('scans the backend roots, is not a frontend, and keeps the history of the migrations out', () => {
    expect(config.roots).toEqual(['src', 'test', 'scripts', 'deploy', 'drizzle', 'compose.yaml', '.env.example']);
    expect(config.frontend).toBe(false);
    expect(config.notScanned.map((entry) => entry.path)).toContain('drizzle/meta');
    expect(config.notScanned.map((entry) => entry.path).some((path) => path.startsWith('drizzle/00[0-3][0-9]'))).toBe(
      true,
    );
  });

  it('protects the PDF shaping: the fonts, both libraries and the two direction functions', () => {
    const kept = config.keep.map((entry) => `${entry.path}|${entry.has ?? ''}`);
    expect(kept).toEqual(
      expect.arrayContaining([
        'src/modules/platform/pdf/pdf-fonts.ts|scriptDirection',
        'src/modules/platform/pdf/text-runs.ts|paragraphDirection',
        'src/modules/platform/pdf/fonts/IBMPlexSansArabic-Regular.ttf|',
        'src/modules/platform/pdf/fonts/IBMPlexSansArabic-Bold.ttf|',
        'package.json|"bidi-js"',
        'package.json|"@pdf-lib/fontkit"',
      ]),
    );
  });

  it('gives every allow entry a reason', () => {
    for (const entry of [...config.allow, ...config.notScanned, ...config.keep]) {
      expect(entry.why.trim().length, entry.path).toBeGreaterThan(20);
    }
  });
});
