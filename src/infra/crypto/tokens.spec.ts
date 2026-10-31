// Unit tests of token hashing, random tokens and constant-time comparison (decision 019), and of the TokenService wrapper.
import { describe, expect, it } from 'bun:test';
import { parseEnv } from '../../config';
import { TokenService } from './token.service';
import { MIN_TOKEN_BYTES, constantTimeEqual, hashToken, randomToken } from './tokens';

const PEPPER = 'p'.repeat(40);

describe('hashToken', () => {
  it('is HMAC-SHA256 as 64 lower-case hex characters, deterministic for one pepper', () => {
    const hash = hashToken(PEPPER, 'session-token-value');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(PEPPER, 'session-token-value')).toBe(hash);
  });

  it('matches the HMAC-SHA256 test vector of RFC 4231 (case 2: key "Jefe")', () => {
    expect(hashToken('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('differs per token and per pepper, so rotating the pepper invalidates every stored hash', () => {
    expect(hashToken(PEPPER, 'a')).not.toBe(hashToken(PEPPER, 'b'));
    expect(hashToken(PEPPER, 'a')).not.toBe(hashToken('q'.repeat(40), 'a'));
  });

  it('does not contain the token', () => {
    expect(hashToken(PEPPER, 'visible-token')).not.toContain('visible-token');
  });
});

describe('randomToken', () => {
  it('makes base64url tokens of the requested entropy', () => {
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).toHaveLength(22);
    expect(randomToken()).toHaveLength(43);
  });

  it('never repeats', () => {
    expect(new Set(Array.from({ length: 1000 }, () => randomToken(16))).size).toBe(1000);
  });

  it('refuses fewer than 16 bytes and non-integers', () => {
    for (const bytes of [0, 8, MIN_TOKEN_BYTES - 1, 16.5, Number.NaN]) {
      expect(() => randomToken(bytes), String(bytes)).toThrow(RangeError);
    }
  });
});

describe('constantTimeEqual', () => {
  it('compares equal and different values, of any length', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual(Buffer.from('xyz'), 'xyz')).toBe(true);
  });
});

describe('TokenService', () => {
  const tokens = new TokenService(parseEnv({ NODE_ENV: 'test', TOKEN_PEPPER: PEPPER }));

  it('hashes with the configured pepper', () => {
    expect(tokens.hash('abc')).toBe(hashToken(PEPPER, 'abc'));
  });

  it('makes tokens and compares them', () => {
    const token = tokens.random();
    expect(token).toHaveLength(43);
    expect(tokens.equals(token, token)).toBe(true);
    expect(tokens.equals(token, tokens.random())).toBe(false);
  });
});
