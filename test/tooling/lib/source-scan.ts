// Reading the production code as text, for the tooling tests that fail on a word or a pattern (decision 064: retired-references, type-words,
// status-compare, buyer-null-checks, email-lookups). A pattern is looked for in the code only: comments are blanked, strings and
// template literals stay, because the raw SQL these tests care about lives in them. Each test proves its pattern on synthetic text first.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The repository root. */
export const ROOT = join(import.meta.dir, '../../..');

/** One place a pattern was found. */
export interface Hit {
  /** the file, relative to the repository root (empty for synthetic text) */
  readonly file: string;
  /** the 1-based line of the start of the match */
  readonly line: number;
  /** the matched text, cut to one line */
  readonly text: string;
}

/** The TypeScript files under a folder of the repository (`src` by default), as paths relative to the root, sorted byte by byte. */
export function sourceFiles(dir = 'src'): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .map((path) => join(dir, path))
    .filter((path) => path.endsWith('.ts') && statSync(join(ROOT, path)).isFile())
    .sort();
}

/** The text of a file of the repository. */
export const readSource = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/**
 * The text with its comments blanked: every character of a comment becomes a space, every newline stays, so a position in the result
 * is the same position in the original. Strings, template literals (with the expressions inside `${ }`, nested ones included) and
 * regular-expression text are not interpreted beyond the quotes; a string that is not closed on its line ends at the line.
 */
export function withoutComments(source: string): string {
  const out: string[] = [];
  // The stack of what the scanner is inside: code (with the depth of braces of a `${ }` expression) or a template literal.
  const stack: Array<{ kind: 'code'; depth: number } | { kind: 'template' }> = [{ kind: 'code', depth: 0 }];
  const length = source.length;
  let i = 0;
  while (i < length) {
    const top = stack[stack.length - 1]!;
    const c = source[i]!;
    const next = source[i + 1] ?? '';
    if (top.kind === 'template') {
      if (c === '\\') {
        out.push(c, next);
        i += 2;
      } else if (c === '`') {
        out.push(c);
        stack.pop();
        i++;
      } else if (c === '$' && next === '{') {
        out.push('${');
        stack.push({ kind: 'code', depth: 0 });
        i += 2;
      } else {
        out.push(c);
        i++;
      }
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < length && source[i] !== '\n') {
        out.push(' ');
        i++;
      }
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? length : end + 2;
      for (; i < stop; i++) out.push(source[i] === '\n' ? '\n' : ' ');
    } else if (c === "'" || c === '"') {
      out.push(c);
      i++;
      while (i < length && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\' && i + 1 < length && source[i + 1] !== '\n') {
          out.push(source[i]!, source[i + 1]!);
          i += 2;
        } else {
          out.push(source[i]!);
          i++;
        }
      }
      if (i < length && source[i] === c) {
        out.push(c);
        i++;
      }
    } else if (c === '`') {
      out.push(c);
      stack.push({ kind: 'template' });
      i++;
    } else if (c === '}' && top.depth === 0 && stack.length > 1) {
      out.push(c);
      stack.pop();
      i++;
    } else {
      if (c === '{') top.depth++;
      else if (c === '}') top.depth--;
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

/**
 * Every place a pattern matches in the code of a source text (comments blanked first).
 * @param file the file name to report (empty for synthetic text)
 * @param source the text
 * @param pattern a pattern; it is run globally whatever its flags
 */
export function scanText(file: string, source: string, pattern: RegExp): Hit[] {
  const code = withoutComments(source);
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const hits: Hit[] = [];
  for (const match of code.matchAll(global)) {
    const line = code.slice(0, match.index).split('\n').length;
    hits.push({ file, line, text: match[0].replace(/\s+/g, ' ').slice(0, 120) });
  }
  return hits;
}

/** One report line per hit, for an assertion that lists what it found: `path:line  text`. */
export const report = (hits: readonly Hit[]): string[] => hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`);

/** Whether a repository path is a schema file of a module (`src/modules/<id>/db/schema.ts`) or the infra barrel (`src/infra/db/schema.ts`). */
export const isSchemaFile = (path: string): boolean =>
  /^src\/modules\/[a-z-]+\/db\/schema\.ts$/.test(path) || path === 'src/infra/db/schema.ts';
