// A guard on the key of stored lookups (decision 054): every hash kept for later matching is made with TokenService.lookupHash
// (LOOKUP_HASH_KEY), never with the credential pepper, so a later edit cannot put a stored lookup back on TOKEN_PEPPER.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** The files that compute a hash stored for later matching. */
const STORED_LOOKUPS = [
  'src/modules/risk/application/blocklist.ts',
  'src/modules/catalog/application/inventory-admin.service.ts',
  'src/modules/platform/notifications/campaigns/unsubscribe-token.ts',
  'src/modules/orders/application/idempotency-store.ts',
  'src/modules/orders/application/order-placement.ts',
  'scripts/seed/risk.ts',
  'scripts/seed/catalog.ts',
  'test/support/risk.ts',
];

describe('stored lookups use the lookup key', () => {
  it('every file that stores a lookup hash calls lookupHash and never the credential hash', () => {
    for (const path of STORED_LOOKUPS) {
      const source = read(path);
      expect(source, path).toContain('lookupHash(');
      expect(source, path).not.toMatch(/tokens?\.hash\(|TokenService\)\.hash\(/);
    }
  });

  it('the link tokens of the shop and the seeded order fingerprints are keyed with the lookup key', () => {
    expect(read('src/infra/crypto/capability-token-vault.ts')).toContain('lookupHash(');
    expect(read('scripts/seed/orders.ts')).toContain('config.security.lookupHashKey');
    expect(read('scripts/seed/orders.ts')).not.toContain('config.security.tokenPepper');
  });
});
