// The reader of production code the tooling tests share (test/tooling/lib/source-scan.ts): comments are blanked and nothing else changes,
// so a pattern never matches a sentence of a comment, and a match is reported on the line it starts.
import { describe, expect, it } from 'bun:test';
import { isSchemaFile, report, scanText, sourceFiles, withoutComments } from './lib/source-scan';

describe('withoutComments', () => {
  it('blanks a line comment and a block comment and keeps every position and every newline', () => {
    const source = 'const a = 1; // customer_id\n/* one\n   two */ const b = 2;\n';
    const code = withoutComments(source);
    expect(code).toHaveLength(source.length);
    expect(code.split('\n')).toHaveLength(source.split('\n').length);
    expect(code).toContain('const a = 1;');
    expect(code).toContain('const b = 2;');
    expect(code).not.toContain('customer_id');
    expect(code).not.toContain('one');
  });

  it('keeps comment markers inside strings, and inside a template literal and its nested templates', () => {
    const source = [
      "const url = 'https://example.test/a'; // gone",
      'const q = sql`select 1 // kept ' + '${cond ? sql`and x // kept too` : sql``} and y // kept as well`; // gone',
    ].join('\n');
    const code = withoutComments(source);
    expect(code).toContain('https://example.test/a');
    expect(code).toContain('// kept ');
    expect(code).toContain('// kept too');
    expect(code).toContain('// kept as well');
    expect(code).not.toContain('gone');
  });

  it('ends a string that is not closed at its line, so a quote inside a regular expression does not swallow the next lines', () => {
    const code = withoutComments("const r = /'/;\nconst x = 1; // gone\n");
    expect(code).toContain('const x = 1;');
    expect(code).not.toContain('gone');
  });

  it('understands an escaped quote and an escaped backtick', () => {
    const code = withoutComments("const a = 'it\\'s // kept'; // gone\nconst b = `a \\` // kept`; // gone");
    expect(code).toContain("it\\'s // kept");
    expect(code).toContain('// kept');
    expect(code).not.toContain('gone');
  });
});

describe('scanText', () => {
  it('finds a pattern in code, once per match, on the line it starts, and never in a comment', () => {
    const source = [
      '// customer_id in a comment',
      'const q = "select customer_id from t";',
      '',
      'const r = "customer_id";',
    ].join('\n');
    const hits = scanText('x.ts', source, /customer_id/);
    expect(hits.map((hit) => hit.line)).toEqual([2, 4]);
    expect(report(hits)).toEqual(['x.ts:2  customer_id', 'x.ts:4  customer_id']);
  });

  it('runs a pattern globally whatever its flags, and reports a match that spans lines on its first line', () => {
    const hits = scanText('', 'eq(\n  lower(clients.email),\n  x)', /eq\(\s*lower\(clients\.email\)/);
    expect(hits).toEqual([{ file: '', line: 1, text: 'eq( lower(clients.email)' }]);
  });
});

describe('the files of a folder', () => {
  it('lists the TypeScript files of src sorted, and none outside it', () => {
    const files = sourceFiles('src');
    expect(files.length).toBeGreaterThan(300);
    expect(files.every((file) => file.startsWith('src/') && file.endsWith('.ts'))).toBe(true);
    expect([...files].sort()).toEqual(files);
    expect(files).toContain('src/infra/db/schema.ts');
  });

  it('tells a schema file from any other file', () => {
    expect(isSchemaFile('src/modules/identity/db/schema.ts')).toBe(true);
    expect(isSchemaFile('src/infra/db/schema.ts')).toBe(true);
    expect(isSchemaFile('src/modules/identity/application/schema.ts')).toBe(false);
    expect(isSchemaFile('src/modules/identity/db/schema-helpers.ts')).toBe(false);
  });
});
