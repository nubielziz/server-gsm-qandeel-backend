// Unit tests of how the shop's link tokens are kept (decisions 010, 019, 054): a keyed hash to find the row and an AES-GCM copy of its column.
import { describe, expect, it } from 'bun:test';
import { parseEnv } from '@src/config';
import { CAPABILITY_TOKEN_COLUMNS, CapabilityTokenVault } from '@src/infra/crypto/capability-token-vault';
import { DecryptionError, EncryptionService } from '@src/infra/crypto/encryption.service';
import { TokenService } from '@src/infra/crypto/token.service';
import { hashToken } from '@src/infra/crypto/tokens';

const config = parseEnv({ NODE_ENV: 'test', LOOKUP_HASH_KEY: 'k'.repeat(40) });
const encryption = new EncryptionService(config);
const tokens = new TokenService(config);
const vault = new CapabilityTokenVault(tokens, encryption);

describe('CapabilityTokenVault', () => {
  it('seals a token as a keyed hash and an encrypted copy of its column', () => {
    const sealed = vault.seal('ticket', 'Zk3b0jY8mQe1xVn7hT2cLw');
    expect(sealed.hash).toBe(hashToken('k'.repeat(40), 'capability:ticket:Zk3b0jY8mQe1xVn7hT2cLw'));
    expect(encryption.decrypt(sealed.enc, 'support_tickets.token_enc')).toBe('Zk3b0jY8mQe1xVn7hT2cLw');
    expect(() => encryption.decrypt(sealed.enc, 'orders.public_token_enc')).toThrow(DecryptionError);
    expect(sealed.enc).not.toContain('Zk3b0jY8mQe1xVn7hT2cLw');
  });

  it('issues 22-character tokens with their stored forms', () => {
    const issued = vault.issue('checkout');
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(issued.hash).toBe(vault.hashOf('checkout', issued.token));
    expect(vault.reveal('checkout', { enc: issued.enc, plain: null })).toBe(issued.token);
    expect(vault.issue('checkout').token).not.toBe(issued.token);
  });

  it('reveals the copy, else the plain form, else null', () => {
    const sealed = vault.seal('tracking', 'abc');
    expect(vault.reveal('tracking', { enc: sealed.enc, plain: null })).toBe('abc');
    expect(vault.reveal('tracking', { enc: null, plain: 'old-plain' })).toBe('old-plain');
    expect(vault.reveal('tracking', { enc: null, plain: null })).toBeNull();
  });

  it('fails loudly when the copy cannot be read, never a wrong link', () => {
    const other = new CapabilityTokenVault(
      tokens,
      new EncryptionService(
        parseEnv({
          NODE_ENV: 'test',
          ENCRYPTION_KEYS: `k9:${Buffer.alloc(32, 9).toString('base64')}`,
          ENCRYPTION_ACTIVE_KID: 'k9',
        }),
      ),
    );
    const sealed = other.seal('ticket', 'abc');
    expect(() => vault.reveal('ticket', { enc: sealed.enc, plain: 'abc' })).toThrow(DecryptionError);
  });

  it('hashes the kinds apart', () => {
    const hashes = (Object.keys(CAPABILITY_TOKEN_COLUMNS) as Array<keyof typeof CAPABILITY_TOKEN_COLUMNS>).map((kind) =>
      vault.hashOf(kind, 'same-token'),
    );
    expect(new Set(hashes).size).toBe(3);
  });
});
