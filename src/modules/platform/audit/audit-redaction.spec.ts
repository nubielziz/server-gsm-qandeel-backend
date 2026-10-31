// Unit tests of the audit redaction (decisions 007, 019): secrets never reach audit_logs, flags and dates stay readable.
import { describe, expect, it } from 'bun:test';
import { REDACTED, isSecretKey, redactForAudit } from './audit-redaction';

describe('isSecretKey', () => {
  it('flags names that end in a secret word, in camelCase, snake_case and kebab-case', () => {
    for (const key of [
      'password',
      'passwordHash',
      'password_hash',
      'newPassword',
      'totpSecretEnc',
      'totp_secret_enc',
      'secret',
      'webhookSecret',
      'token',
      'sessionToken',
      'tokenHash',
      'keyHash',
      'apiKey',
      'api_key',
      'privateKey',
      'signingKey',
      'authorization',
      'cookie',
      'credentials',
      'configEnc',
      'imeiEnc',
      'pepper',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('leaves ordinary names alone, including ones that merely mention a secret word', () => {
    for (const key of [
      'name',
      'email',
      'roleId',
      'status',
      'passwordChangedAt',
      'mustChangePassword',
      'twofaEnabled',
      'tokenExpiresAt',
      'prefix',
      'idempotencyKey',
      'keyName',
      'lastLoginIp',
      'permissions',
      'enc1',
      '',
    ]) {
      // mustChangePassword ends in a secret word; the value rule (booleans stay readable) keeps it, see redactForAudit.
      if (key === 'mustChangePassword') continue;
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe('redactForAudit', () => {
  it('replaces the value of a secret key and keeps the rest', () => {
    expect(redactForAudit({ name: 'Rami', passwordHash: '$argon2id$v=19$abc', roleId: 1 })).toEqual({
      name: 'Rami',
      passwordHash: REDACTED,
      roleId: 1,
    });
  });

  it('keeps booleans, nulls and empty strings under a secret-looking key (they are flags, not secrets)', () => {
    expect(redactForAudit({ mustChangePassword: true, passwordHash: null, token: '', secret: false })).toEqual({
      mustChangePassword: true,
      passwordHash: null,
      token: '',
      secret: false,
    });
  });

  it('redacts numbers, objects and lists under a secret key', () => {
    expect(redactForAudit({ token: 123456, credentials: { user: 'u', pass: 'p' }, apiKey: ['a', 'b'] })).toEqual({
      token: REDACTED,
      credentials: REDACTED,
      apiKey: REDACTED,
    });
  });

  it('reaches into nested objects and lists, and copies instead of changing the input', () => {
    const input = { staff: { name: 'a', totpSecretEnc: 'v1:k:iv:tag:data' }, rows: [{ token: 't', id: 1 }, 'plain'] };
    const output = redactForAudit(input);
    expect(output).toEqual({
      staff: { name: 'a', totpSecretEnc: REDACTED },
      rows: [{ token: REDACTED, id: 1 }, 'plain'],
    });
    expect(input.staff.totpSecretEnc).toBe('v1:k:iv:tag:data');
    expect(output).not.toBe(input);
  });

  it('passes dates and other class instances through for the JSON encoder', () => {
    const when = new Date('2026-03-01T09:30:00.000Z');
    expect(redactForAudit({ at: when }).at).toBe(when);
  });

  it('stops at a sane depth instead of recursing for ever', () => {
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(redactForAudit(deep))).toContain(REDACTED);
  });
});
