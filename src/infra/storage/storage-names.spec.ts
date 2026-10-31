// Unit tests of the object key, content type and download header rules (decision 004).
import { describe, expect, it } from 'bun:test';
import { assertContentType, assertObjectKey, attachmentDisposition } from './storage-names';

describe('assertObjectKey', () => {
  it('accepts keys made of letters, digits and . _ = + - in slash-separated segments', () => {
    for (const key of [
      'a',
      'files/2026/10/0192f6c4-7b1e-7d5e-8c5e-1f2a3b4c5d6e',
      'kyc/m12/passport.pdf',
      'results/order=42/final+v2.txt',
      'A1_b-2.c',
      'x'.repeat(512),
    ]) {
      expect(() => assertObjectKey(key), key.slice(0, 40)).not.toThrow();
    }
  });

  it('refuses empty keys, leading or trailing slashes, empty segments and dot segments', () => {
    for (const key of ['', '/a', 'a/', 'a//b', './a', 'a/./b', '../etc/passwd', 'a/../b', 'a/..', '.hidden', 'a/.b']) {
      expect(() => assertObjectKey(key), key).toThrow(RangeError);
    }
  });

  it('refuses spaces, control characters, backslashes, query characters and non-ASCII', () => {
    for (const key of ['a b', 'a\tb', 'a\nb', 'a\\b', 'a?b', 'a#b', 'a%2e', 'a*b', 'مف/تاح', 'a\u0000b', 'a:b']) {
      expect(() => assertObjectKey(key), JSON.stringify(key)).toThrow(RangeError);
    }
  });

  it('refuses keys longer than 512 characters, and does not echo more than the start of a long key', () => {
    const key = 'x'.repeat(513);
    expect(() => assertObjectKey(key)).toThrow(RangeError);
    try {
      assertObjectKey(key);
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(200);
    }
  });
});

describe('assertContentType', () => {
  it('accepts media types, with and without parameters', () => {
    for (const type of [
      'application/pdf',
      'image/png',
      'text/csv; charset=utf-8',
      'application/vnd.ms-excel',
      'application/octet-stream',
      'text/plain;charset="utf-8"',
      'IMAGE/JPEG',
      'application/problem+json',
    ]) {
      expect(() => assertContentType(type), type).not.toThrow();
    }
  });

  it('refuses things that are not a type/subtype', () => {
    for (const type of [
      '',
      'pdf',
      'application/',
      '/pdf',
      'text/plain\r\nX-Evil: 1',
      'a b/c',
      'text/plain; =x',
      'x'.repeat(201),
    ]) {
      expect(() => assertContentType(type), JSON.stringify(type.slice(0, 40))).toThrow(RangeError);
    }
  });
});

describe('attachmentDisposition', () => {
  it('writes an attachment with an ASCII name and the UTF-8 form', () => {
    expect(attachmentDisposition('report.csv')).toBe(`attachment; filename="report.csv"; filename*=UTF-8''report.csv`);
  });

  it('encodes non-ASCII names for old and new clients', () => {
    const header = attachmentDisposition('تقرير ✓.pdf');
    expect(header).toBe(
      `attachment; filename="_____ _.pdf"; filename*=UTF-8''%D8%AA%D9%82%D8%B1%D9%8A%D8%B1%20%E2%9C%93.pdf`,
    );
  });

  it('removes quotes, slashes, backslashes and control characters that could break the header or the path', () => {
    for (const name of ['a"b.txt', 'a/b.txt', 'a\\b.txt', 'a\r\nSet-Cookie: x=1', '../../etc/passwd']) {
      const header = attachmentDisposition(name);
      expect(header, name).not.toMatch(/[\r\n]/);
      const quoted = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
      expect(quoted, name).not.toMatch(/["\\/\r\n]/);
      expect(header.startsWith('attachment; filename="'), name).toBe(true);
    }
    expect(attachmentDisposition('a"b.txt')).toContain('filename="a_b.txt"');
  });

  it('escapes the characters RFC 5987 reserves in the UTF-8 form', () => {
    expect(attachmentDisposition("it's (1)*.txt")).toContain("filename*=UTF-8''it%27s%20%281%29%2A.txt");
  });

  it('falls back to "download" for an empty name and bounds the length', () => {
    expect(attachmentDisposition('')).toContain('filename="download"');
    expect(attachmentDisposition('   ')).toContain('filename="download"');
    expect(/filename="([^"]*)"/.exec(attachmentDisposition('x'.repeat(1000)))?.[1]).toHaveLength(180);
  });
});
