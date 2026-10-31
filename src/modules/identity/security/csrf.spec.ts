// Unit tests of the CSRF token (decision 018): HMAC(CSRF_SECRET, session token hash), constant-time comparison, 403 CSRF_FAILED.
import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { AppError } from '../../../common/errors';
import { parseEnv } from '../../../config';
import { CSRF_HEADER, CsrfService, csrfTokenFor } from './csrf';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const service = new CsrfService(parseEnv({ NODE_ENV: 'test' }));

describe('csrfTokenFor', () => {
  it('is the hex HMAC-SHA256 of the session token hash under the secret', () => {
    expect(csrfTokenFor('secret-secret-secret-secret-secret-0', HASH_A)).toBe(
      createHmac('sha256', 'secret-secret-secret-secret-secret-0').update(HASH_A).digest('hex'),
    );
    expect(csrfTokenFor('secret-secret-secret-secret-secret-0', HASH_A)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('depends on both the secret and the session', () => {
    const base = csrfTokenFor('secret-secret-secret-secret-secret-0', HASH_A);
    expect(csrfTokenFor('secret-secret-secret-secret-secret-0', HASH_A)).toBe(base);
    expect(csrfTokenFor('secret-secret-secret-secret-secret-1', HASH_A)).not.toBe(base);
    expect(csrfTokenFor('secret-secret-secret-secret-secret-0', HASH_B)).not.toBe(base);
  });
});

describe('CsrfService', () => {
  it('names the header the console sends', () => {
    expect(CSRF_HEADER).toBe('x-csrf-token');
  });

  it('accepts the token of its own session only', () => {
    const token = service.tokenFor(HASH_A);
    expect(service.matches(HASH_A, token)).toBe(true);
    expect(service.matches(HASH_B, token)).toBe(false);
    expect(service.matches(HASH_A, service.tokenFor(HASH_B))).toBe(false);
  });

  it('refuses a missing, empty, altered, truncated or repeated token', () => {
    const token = service.tokenFor(HASH_A);
    expect(service.matches(HASH_A, undefined)).toBe(false);
    expect(service.matches(HASH_A, '')).toBe(false);
    expect(service.matches(HASH_A, `${token}x`)).toBe(false);
    expect(service.matches(HASH_A, token.slice(0, -1))).toBe(false);
    expect(service.matches(HASH_A, token.toUpperCase())).toBe(false);
    expect(service.matches(HASH_A, [token, token])).toBe(false);
  });

  it('assert answers 403 CSRF_FAILED whose detail says missing or mismatched', () => {
    const token = service.tokenFor(HASH_A);
    expect(() => service.assert(HASH_A, token)).not.toThrow();
    for (const [presented, word] of [
      [undefined, 'missing'],
      ['', 'missing'],
      ['nope', 'does not match'],
    ] as const) {
      try {
        service.assert(HASH_A, presented);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect(error).toMatchObject({ code: 'CSRF_FAILED', status: 403 });
        expect((error as AppError).detail).toContain(word);
      }
    }
  });
});
