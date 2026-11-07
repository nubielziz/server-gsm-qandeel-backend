// Unit tests of TotpService: the stored form, the authenticator link and QR code, and the time-step rules (±1 step, replay).
import { describe, expect, it } from 'bun:test';
import { generate } from 'otplib';
import { parseEnv } from '../../../config';
import { DecryptionError, EncryptionService } from '../../../infra/crypto';
import { CLIENT_TOTP_AAD, STAFF_TOTP_AAD, TOTP_ISSUER, TotpService } from './totp.service';

const service = new TotpService(new EncryptionService(parseEnv({ NODE_ENV: 'test' })));
// A fixed moment in the middle of a time step, so the neighbouring steps are exactly 30 seconds apart.
const NOW = 1_800_000_015_000;
const stepOf = (ms: number) => Math.floor(ms / 1000 / 30);
const codeAt = (secret: string, ms: number) => generate({ secret, epoch: ms / 1000 });

describe('secrets', () => {
  it('makes 160-bit base32 secrets that differ every time', () => {
    const a = service.newSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(service.newSecret()).not.toBe(a);
  });

  it('stores them encrypted for this column only', () => {
    const secret = service.newSecret();
    const stored = service.seal(secret);
    expect(stored).toStartWith('v1:');
    expect(stored).not.toContain(secret);
    expect(service.open(stored)).toBe(secret);
    const encryption = new EncryptionService(parseEnv({ NODE_ENV: 'test' }));
    expect(() => encryption.decrypt(stored, 'staff_users.password_hash')).toThrow(DecryptionError);
  });
});

describe('merchant secrets (feature 2b)', () => {
  it('are stored for the clients column and do not open as a staff secret, or the other way round', () => {
    const secret = service.newSecret();
    const stored = service.seal(secret, CLIENT_TOTP_AAD);
    expect(service.open(stored, CLIENT_TOTP_AAD)).toBe(secret);
    expect(() => service.open(stored)).toThrow(DecryptionError);
    expect(() => service.open(service.seal(secret, STAFF_TOTP_AAD), CLIENT_TOTP_AAD)).toThrow(DecryptionError);
  });
});

describe('the authenticator link', () => {
  it('names the issuer and the account, and draws an SVG QR code', async () => {
    const secret = service.newSecret();
    const uri = service.uriFor('rami@gsm-supply.example', secret);
    expect(uri).toStartWith('otpauth://totp/');
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('rami%40gsm-supply.example');
    expect(uri).toContain(`issuer=${encodeURIComponent(TOTP_ISSUER)}`);
    expect(await service.qrSvg(uri)).toStartWith('<svg');
  });
});

describe('check', () => {
  it('accepts the codes of the current step and one step either side, and returns the step', async () => {
    const secret = service.newSecret();
    for (const offset of [-30_000, 0, 30_000]) {
      expect(await service.check(secret, await codeAt(secret, NOW + offset), null, NOW)).toBe(stepOf(NOW + offset));
    }
  });

  it('refuses codes two steps away, wrong codes and codes of another secret', async () => {
    const secret = service.newSecret();
    expect(await service.check(secret, await codeAt(secret, NOW - 60_000), null, NOW)).toBeUndefined();
    expect(await service.check(secret, await codeAt(secret, NOW + 60_000), null, NOW)).toBeUndefined();
    expect(await service.check(secret, '000000', null, NOW)).toBeUndefined();
    expect(await service.check(secret, await codeAt(service.newSecret(), NOW), null, NOW)).toBeUndefined();
  });

  it('refuses a step that is not newer than the last accepted one, even with the right code', async () => {
    const secret = service.newSecret();
    const current = stepOf(NOW);
    expect(await service.check(secret, await codeAt(secret, NOW), current, NOW)).toBeUndefined();
    expect(await service.check(secret, await codeAt(secret, NOW - 30_000), current, NOW)).toBeUndefined();
    expect(await service.check(secret, await codeAt(secret, NOW + 30_000), current, NOW)).toBe(current + 1);
  });
});
