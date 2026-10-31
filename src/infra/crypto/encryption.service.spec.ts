// Unit tests of the AES-256-GCM keyring (decision 019): round trip, the stored format, tamper detection, AAD binding, key
// rotation with an older key id, and that failures never reveal plaintext or key material.
import { describe, expect, it } from 'bun:test';
import { parseEnv } from '../../config';
import { DecryptionError, EncryptionService } from './encryption.service';

const KEY_1 = Buffer.alloc(32, 1).toString('base64');
const KEY_2 = Buffer.alloc(32, 2).toString('base64');
const AAD = 'suppliers.credentials_enc';

/** A service whose keyring holds the given keys; the first one listed is active unless `active` says otherwise. */
function serviceWith(keys: Record<string, string>, active = Object.keys(keys)[0]!): EncryptionService {
  const config = parseEnv({
    NODE_ENV: 'test',
    ENCRYPTION_KEYS: Object.entries(keys)
      .map(([kid, key]) => `${kid}:${key}`)
      .join(','),
    ENCRYPTION_ACTIVE_KID: active,
  });
  return new EncryptionService(config);
}

describe('EncryptionService', () => {
  const service = serviceWith({ k1: KEY_1 });

  it('round-trips text, including empty text and non-ASCII text', () => {
    for (const plaintext of ['{"apiKey":"abc123","user":"rami"}', '', 'مرحبا — ünïcode ✓', 'x'.repeat(100_000)]) {
      expect(service.decrypt(service.encrypt(plaintext, AAD), AAD)).toBe(plaintext);
    }
  });

  it('writes v1:<kid>:<iv>:<tag>:<ciphertext> with base64url parts, a 12-byte IV and a 16-byte tag', () => {
    const stored = service.encrypt('secret', AAD);
    const parts = stored.split(':');
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('v1');
    expect(parts[1]).toBe('k1');
    expect(Buffer.from(parts[2]!, 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[3]!, 'base64url')).toHaveLength(16);
    expect(Buffer.from(parts[4]!, 'base64url').toString()).not.toContain('secret');
    for (const part of parts.slice(2)) expect(part).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(stored).not.toContain('secret');
  });

  it('uses a fresh IV every time, so equal plaintexts give different values', () => {
    const values = new Set(Array.from({ length: 50 }, () => service.encrypt('same text', AAD)));
    expect(values.size).toBe(50);
    expect(new Set([...values].map((value) => value.split(':')[2])).size).toBe(50);
  });

  it('detects a modified ciphertext, tag or IV', () => {
    const [version, kid, iv, tag, ciphertext] = service.encrypt('pay 100 to account 7', AAD).split(':');
    const flip = (part: string) => {
      const bytes = Buffer.from(part, 'base64url');
      bytes[0] = (bytes[0] ?? 0) ^ 0x01;
      return bytes.toString('base64url');
    };
    for (const tampered of [
      [version, kid, iv, tag, flip(ciphertext!)],
      [version, kid, iv, flip(tag!), ciphertext],
      [version, kid, flip(iv!), tag, ciphertext],
    ]) {
      expect(() => service.decrypt(tampered.join(':'), AAD)).toThrow(DecryptionError);
      try {
        service.decrypt(tampered.join(':'), AAD);
      } catch (error) {
        expect((error as DecryptionError).reason).toBe('authentication_failed');
      }
    }
  });

  it('binds the value to its column: the same text under another AAD does not decrypt', () => {
    const stored = service.encrypt('totp-secret', 'staff_users.totp_secret_enc');
    expect(() => service.decrypt(stored, 'gateways.credentials_enc')).toThrow(DecryptionError);
    expect(service.decrypt(stored, 'staff_users.totp_secret_enc')).toBe('totp-secret');
  });

  it('refuses a malformed value with reason "malformed"', () => {
    const reasonOf = (text: string): string | undefined => {
      try {
        service.decrypt(text, AAD);
      } catch (error) {
        return (error as DecryptionError).reason;
      }
      return undefined;
    };
    for (const text of [
      '',
      'plain text',
      'v1:k1:a:b',
      'v2:k1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:',
      'v1:k1:!!!:???:###',
    ]) {
      expect(reasonOf(text), text).toBe('malformed');
    }
    // right shape, wrong sizes
    expect(reasonOf('v1:k1:AAAA:AAAA:AAAA')).toBe('malformed');
  });

  it('refuses a value sealed by a key that is not in the keyring', () => {
    const other = serviceWith({ gone: KEY_2 });
    const stored = other.encrypt('x', AAD);
    try {
      service.decrypt(stored, AAD);
      throw new Error('should not decrypt');
    } catch (error) {
      expect(error).toBeInstanceOf(DecryptionError);
      expect((error as DecryptionError).reason).toBe('unknown_key');
    }
  });

  it('rejects an AAD that is not <table>.<column>', () => {
    for (const aad of ['', 'suppliers', 'Suppliers.Credentials', 'a.b.c', 'a b.c', 'suppliers.credentials_enc ']) {
      expect(() => service.encrypt('x', aad), aad).toThrow(RangeError);
      expect(() => service.decrypt('v1:k1:a:b:c', aad), aad).toThrow(RangeError);
    }
  });

  describe('key rotation', () => {
    it('decrypts a value sealed by an older key while that key is still in the keyring', () => {
      const old = serviceWith({ k1: KEY_1 });
      const sealedByOld = old.encrypt('legacy credentials', AAD);
      const rotated = serviceWith({ k1: KEY_1, k2: KEY_2 }, 'k2');
      expect(rotated.activeKid).toBe('k2');
      expect(rotated.keyIdOf(sealedByOld)).toBe('k1');
      expect(rotated.decrypt(sealedByOld, AAD)).toBe('legacy credentials');
      // New values use the active key.
      expect(rotated.keyIdOf(rotated.encrypt('new', AAD))).toBe('k2');
    });

    it('flags old values for the maintenance job and re-encrypts them with the active key', () => {
      const old = serviceWith({ k1: KEY_1 });
      const sealedByOld = old.encrypt('legacy credentials', AAD);
      const rotated = serviceWith({ k1: KEY_1, k2: KEY_2 }, 'k2');
      expect(rotated.needsRotation(sealedByOld)).toBe(true);
      const renewed = rotated.rotate(sealedByOld, AAD);
      expect(rotated.needsRotation(renewed)).toBe(false);
      expect(rotated.keyIdOf(renewed)).toBe('k2');
      expect(rotated.decrypt(renewed, AAD)).toBe('legacy credentials');
      // Once the old key is retired, the renewed value still works and the old one does not.
      const retired = serviceWith({ k2: KEY_2 });
      expect(retired.decrypt(renewed, AAD)).toBe('legacy credentials');
      expect(() => retired.decrypt(sealedByOld, AAD)).toThrow(DecryptionError);
    });

    it('treats text that is not ours as needing rotation', () => {
      expect(service.keyIdOf('not encrypted')).toBeUndefined();
      expect(service.needsRotation('not encrypted')).toBe(true);
    });
  });

  it('never puts plaintext, ciphertext or keys in an error message', () => {
    const stored = service.encrypt('super secret credentials', AAD);
    const tampered = `${stored.slice(0, -2)}AA`;
    try {
      service.decrypt(tampered, AAD);
    } catch (error) {
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      for (const leak of ['super secret', KEY_1, tampered, stored.split(':')[4]!]) expect(text).not.toContain(leak);
    }
  });
});
