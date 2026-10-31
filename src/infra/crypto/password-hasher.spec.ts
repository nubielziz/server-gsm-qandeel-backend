// Unit tests of the argon2id password hasher (decision 007): PHC prefix, verify, parameters from the config, rehash check.
import { describe, expect, it } from 'bun:test';
import { parseEnv } from '../../config';
import { MAX_PASSWORD_BYTES, PasswordHasher } from './password-hasher';
import { expectRejection } from '../../../test/support/rejection';

/** Small costs keep the test fast; the production defaults are checked through the config tests. */
const cheap = (extra: Record<string, string> = {}) =>
  new PasswordHasher(
    parseEnv({ NODE_ENV: 'test', ARGON2_MEMORY_KIB: '512', ARGON2_TIME_COST: '1', ARGON2_PARALLELISM: '1', ...extra }),
  );

describe('PasswordHasher', () => {
  const hasher = cheap();

  it('produces an argon2id PHC string with the configured parameters', async () => {
    const hashed = await hasher.hash('correct horse battery staple');
    expect(hashed.startsWith('$argon2id$')).toBe(true);
    expect(hashed).toMatch(/^\$argon2id\$v=19\$m=512,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(hashed).not.toContain('correct horse');
  });

  it('uses the default cost of the config when nothing is set (OWASP baseline)', async () => {
    const hashed = await new PasswordHasher(parseEnv({ NODE_ENV: 'test' })).hash('a password');
    expect(hashed).toContain('$argon2id$v=19$m=19456,t=2,p=1$');
  });

  it('salts every hash', async () => {
    const [a, b] = await Promise.all([hasher.hash('same password'), hasher.hash('same password')]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const hashed = await hasher.hash('s3cret-Passw0rd');
    expect(await hasher.verify(hashed, 's3cret-Passw0rd')).toBe(true);
    expect(await hasher.verify(hashed, 's3cret-Passw0rd ')).toBe(false);
    expect(await hasher.verify(hashed, 'S3cret-Passw0rd')).toBe(false);
    expect(await hasher.verify(hashed, '')).toBe(false);
  });

  it('verifies a hash made with other parameters (they travel in the PHC string)', async () => {
    const stronger = await cheap({ ARGON2_MEMORY_KIB: '1024', ARGON2_TIME_COST: '2' }).hash('pw');
    expect(await hasher.verify(stronger, 'pw')).toBe(true);
  });

  it('never verifies a value that is not an argon2id hash, and never throws on garbage', async () => {
    expect(await hasher.verify('plaintext', 'plaintext')).toBe(false);
    expect(await hasher.verify('', '')).toBe(false);
    expect(await hasher.verify('$argon2id$garbage', 'x')).toBe(false);
    // other algorithms are refused even when they are valid hashes
    expect(
      await hasher.verify('$argon2i$v=19$m=16,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$ZVlYDZNaFqEp6vYWvuL4rUb3ZpUX3PsM', 'x'),
    ).toBe(false);
  });

  it('refuses to hash an empty or oversize password', async () => {
    await expectRejection(hasher.hash(''), RangeError);
    await expectRejection(hasher.hash('x'.repeat(MAX_PASSWORD_BYTES + 1)), RangeError);
    expect(await hasher.verify(await hasher.hash('ok'), 'x'.repeat(MAX_PASSWORD_BYTES + 1))).toBe(false);
  });

  it('hashes long and non-ASCII passwords', async () => {
    for (const password of ['x'.repeat(MAX_PASSWORD_BYTES), 'كلمة سر طويلة جداً ✓']) {
      expect(await hasher.verify(await hasher.hash(password), password)).toBe(true);
    }
  });

  describe('needsRehash', () => {
    it('is false for a hash made with the current parameters', async () => {
      expect(hasher.needsRehash(await hasher.hash('pw'))).toBe(false);
    });

    it('is true when any parameter is now higher in the config, or the value is not an argon2id hash', async () => {
      const old = await hasher.hash('pw');
      expect(cheap({ ARGON2_MEMORY_KIB: '1024' }).needsRehash(old)).toBe(true);
      expect(cheap({ ARGON2_TIME_COST: '2' }).needsRehash(old)).toBe(true);
      expect(cheap({ ARGON2_PARALLELISM: '2', ARGON2_MEMORY_KIB: '1024' }).needsRehash(old)).toBe(true);
      expect(hasher.needsRehash('$2b$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz01234')).toBe(true);
      expect(hasher.needsRehash('garbage')).toBe(true);
    });

    it('is false when the config is lower than the stored hash (never downgrade)', async () => {
      const stronger = await cheap({ ARGON2_MEMORY_KIB: '1024', ARGON2_TIME_COST: '2' }).hash('pw');
      expect(hasher.needsRehash(stronger)).toBe(false);
    });
  });
});
