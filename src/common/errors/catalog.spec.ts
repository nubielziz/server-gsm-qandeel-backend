// Unit test: the catalog and docs/contract/error-codes.md list the same codes with the same statuses (D028, D009).
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ERROR_CATALOG, isErrorCode, problemSlug, statusOf, titleOf } from './catalog';

/** Reads `| CODE | status |` rows from the generated table in error-codes.md. */
function readDocumentedCodes(): Map<string, number> {
  const text = readFileSync(join(import.meta.dir, '../../../docs/contract/error-codes.md'), 'utf8');
  const rows = new Map<string, number>();
  for (const match of text.matchAll(/^\| ([A-Z][A-Z0-9_]+) \| (\d{3}) \|/gm)) {
    expect(rows.has(match[1]!)).toBe(false);
    rows.set(match[1]!, Number(match[2]));
  }
  return rows;
}

describe('error catalog', () => {
  it('lists exactly the codes of error-codes.md with the same statuses', () => {
    const documented = readDocumentedCodes();
    expect(documented.size).toBe(123);
    expect([...Object.keys(ERROR_CATALOG)].sort()).toEqual([...documented.keys()].sort());
    for (const [code, status] of documented) expect(statusOf(code as never)).toBe(status);
  });

  it('gives every code a short, plain-English sentence as title', () => {
    for (const [code, entry] of Object.entries(ERROR_CATALOG)) {
      expect(entry.title.length).toBeGreaterThan(10);
      expect(entry.title.length).toBeLessThanOrEqual(80);
      expect(entry.title.endsWith('.')).toBe(true);
      expect(entry.title).toMatch(/^[A-Z]/);
      expect(entry.title).not.toMatch(/[<>{}]/);
      // One sentence only.
      expect(entry.title.match(/\./g)?.length, code).toBe(1);
    }
  });

  it('uses unique titles so the console never shows two codes the same way', () => {
    const titles = Object.values(ERROR_CATALOG).map((entry) => entry.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('uses valid HTTP error statuses', () => {
    for (const entry of Object.values(ERROR_CATALOG)) {
      expect(entry.status).toBeGreaterThanOrEqual(400);
      expect(entry.status).toBeLessThanOrEqual(599);
    }
  });

  it('knows the codes the framework layer needs', () => {
    for (const code of [
      'BAD_REQUEST',
      'NOT_FOUND',
      'PAYLOAD_TOO_LARGE',
      'UNSUPPORTED_MEDIA_TYPE',
      'VALIDATION_FAILED',
      'INTERNAL_ERROR',
      'RESPONSE_CONTRACT_VIOLATION',
      'FORBIDDEN',
    ]) {
      expect(isErrorCode(code)).toBe(true);
    }
    expect(isErrorCode('toString')).toBe(false);
    expect(isErrorCode('nope')).toBe(false);
  });

  it('exposes status, title and the kebab-case slug of the problem type', () => {
    expect(statusOf('EMAIL_TAKEN')).toBe(409);
    expect(titleOf('EMAIL_TAKEN')).toBe('This email address is already in use.');
    expect(problemSlug('VALIDATION_FAILED')).toBe('validation-failed');
    expect(problemSlug('TWOFA_ALREADY_ENABLED')).toBe('twofa-already-enabled');
  });
});
