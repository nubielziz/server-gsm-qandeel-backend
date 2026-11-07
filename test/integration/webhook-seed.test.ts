// The seed of feature 7b (`bun run db:seed`): the demo merchants' API keys and the webhook log of the console's Webhook deliveries tab, written as
// the frontend mocks show them, with only hashes and encrypted secrets stored, and idempotent. Needs the frontend checkout.
import { afterAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { parseEnv } from '../../src/config';
import { EncryptionService, hashToken } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import {
  WEBHOOK_EVENT_NAMES,
  invoicePaid,
  orderStatusChanged,
  servicePriceChanged,
  walletLowBalance,
} from '../../src/modules/platform';
import { WEBHOOK_SECRET_AAD } from '../../src/modules/platform/webhooks/webhook-deliveries';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { seedIdentity } from '../../scripts/seed/identity';
import { seedPlatform } from '../../scripts/seed/platform';
import { TEST_DATABASE_URL, closeTestDb, resetDb, testDb } from '../support/db';
import { testInstanceEnv } from '../support/env';

setDefaultTimeout(60_000);

const config = parseEnv({ NODE_ENV: 'test', DATABASE_URL_TEST: TEST_DATABASE_URL, ...testInstanceEnv() });
const frontendPresent = existsSync(demoStatePath());

beforeEach(resetDb);
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

async function seedBoth() {
  const { db } = await testDb();
  const demo = await loadDemoState();
  return db.transaction(async (tx) => ({
    identity: await seedIdentity(tx, demo, config),
    platform: await seedPlatform(tx, demo, config),
  }));
}

describe.skipIf(!frontendPresent)('the 7b seed', () => {
  it('writes a Production key for each merchant that is not pending, a Staging and a revoked Legacy key for the first, as hashes', async () => {
    const reports = await seedBoth();
    const { db } = await testDb();
    const merchants = await db.select().from(s.clients).orderBy(s.clients.id);
    const live = merchants.filter((merchant) => merchant.status !== 'pending').length;
    expect(reports.identity.find((report) => report.table === 'api_keys')).toMatchObject({ inserted: live + 2 });

    const keys = await db.select().from(s.apiKeys).orderBy(s.apiKeys.id);
    expect(keys).toHaveLength(live + 2);
    const [first] = keys;
    expect(first).toMatchObject({ name: 'Production', clientId: merchants[0]!.id, rateLimitPerMin: 120 });
    expect(first?.scopes).toEqual(['orders:write', 'orders:read', 'account:read']);
    expect(first?.keyHash).toBe(hashToken(config.security.tokenPepper, 'gsm_live_69xx31_seed0000'));
    expect(first?.prefix).toBe('gsm_live');
    expect(first?.allowedIps).toEqual(['203.0.113.55/32']);
    expect(keys.slice(-2).map((key) => [key.name, key.revokedAt !== null])).toEqual([
      ['Staging', false],
      ['Legacy integration', true],
    ]);
    for (const key of keys) expect(key.keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes an endpoint for each of the first four merchants and 36 deliveries with the mock’s outcomes', async () => {
    await seedBoth();
    const { db } = await testDb();
    const endpoints = await db.select().from(s.webhookEndpoints).orderBy(s.webhookEndpoints.id);
    expect(endpoints).toHaveLength(4);
    const encryption = new EncryptionService(config);
    expect(encryption.decrypt(endpoints[0]!.secretEnc, WEBHOOK_SECRET_AAD)).toBe('whsec_seed_1_development_only');
    expect(endpoints[0]?.url).toBe('https://hooks.zain-mobile-hub.example/gsm');

    const deliveries = await db.select().from(s.webhookDeliveries).orderBy(s.webhookDeliveries.id);
    expect(deliveries).toHaveLength(36);
    const contracts = { invoicePaid, orderStatusChanged, servicePriceChanged, walletLowBalance };
    const contractOf = Object.fromEntries(Object.values(contracts).map((contract) => [contract.name, contract]));
    for (const delivery of deliveries) {
      expect(WEBHOOK_EVENT_NAMES as readonly string[]).toContain(delivery.event);
      const envelope = delivery.payload as { id: string; type: string; data: unknown };
      expect(envelope.id).toBe(delivery.eventId);
      expect(envelope.type).toBe(delivery.event);
      // Each event carries its own documented data (an invoice for invoice.paid, not an order).
      expect(contractOf[delivery.event]?.payload.safeParse(envelope.data).success, delivery.event).toBe(true);
    }
    const byStatus = (status: string) => deliveries.filter((delivery) => delivery.status === status).length;
    expect([byStatus('delivered'), byStatus('failed'), byStatus('pending')]).toEqual([24, 8, 4]);
    expect(
      deliveries.filter((delivery) => delivery.status === 'failed' && delivery.responseCode === null),
    ).not.toHaveLength(0);
    expect(
      deliveries.filter((delivery) => delivery.status === 'pending').every((delivery) => delivery.nextRetryAt !== null),
    ).toBe(true);
  });

  it('is idempotent and moves the id sequences past the seeded rows', async () => {
    await seedBoth();
    const second = await seedBoth();
    for (const report of [...second.identity, ...second.platform]) expect(report.inserted, report.table).toBe(0);
    const { db } = await testDb();
    const [endpoint] = await db
      .insert(s.webhookEndpoints)
      .values({ clientId: 1, url: 'https://hooks.example.com/x', secretEnc: 'v1:k:a:b:c', events: [] })
      .returning({ id: s.webhookEndpoints.id });
    expect(endpoint?.id).toBeGreaterThan(4);
    expect(
      (await db.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, endpoint!.id)))[0],
    ).toBeDefined();
  });
});
