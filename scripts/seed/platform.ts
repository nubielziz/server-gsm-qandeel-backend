// Seeder of the platform module: the settings the frontend demo starts with.
// Mirrors src/mocks/settings.ts: `adminAllowlistOnly` comes from the demo's `access.restrict`.
import type { AppConfig } from '../../src/config';
import { EncryptionService, TokenService } from '../../src/infra/crypto';
import { schema as s, type DbExecutor } from '../../src/infra/db';
import { WEBHOOK_SECRET_AAD } from '../../src/modules/platform/webhooks/webhook-deliveries';
import { type DemoSeed, demoNumericId, demoRows } from './demo-state';
import { type SeedReport, insertRows, syncIdentity } from './helpers';

/**
 * Seeds the admin allowlist switch.
 *
 * Why: the console reads the IP restriction state from `GET /admin/settings` (key `adminAllowlistOnly`, RULES M14);
 * the demo starts with it on, next to the demo allow rules.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @returns one report per table
 */
export async function seedPlatform(db: DbExecutor, demo: DemoSeed, config?: AppConfig): Promise<SeedReport[]> {
  const access = demo.state.access as { restrict?: boolean } | undefined;
  const settings = await insertRows(db, s.settings, [{ key: 'adminAllowlistOnly', value: access?.restrict ?? false }]);
  await syncIdentity(db, s.settings);
  // The endpoints need the encryption key and the deliveries the token pepper (the event ids): without a configuration there are none.
  const webhooks = config ? await seedWebhooks(db, demo, config) : [];
  return [settings, ...webhooks];
}

const MINUTE_MS = 60_000;

/** The events the seeded deliveries cycle through (the public four). */
const SEED_EVENTS = ['order.status_changed', 'wallet.low_balance', 'invoice.paid', 'service.price_changed'] as const;

/**
 * Seeds the webhook log the console's Webhook deliveries tab shows: an endpoint for each of the first four demo merchants and 36
 * deliveries over them, newest first, with the outcomes of the frontend mock (`deliveryRows` in
 * src/features/settings/mocks/seedWebhooks.ts): mostly delivered, some refused with 500, one that never answered, one waiting.
 *
 * Why: the demo has no webhook log; the console mock made one up. The same rows through the real API keep the screen alive in
 * development. The event names are the real ones (the mock's `order.completed` is illustrative) and the signing secret of every
 * endpoint is a development value.
 *
 * @param db the transaction to write with
 * @param demo the loaded frontend demo state
 * @param config the application configuration (encryption keys and token pepper)
 * @returns the reports of `webhook_endpoints` and `webhook_deliveries`
 */
async function seedWebhooks(db: DbExecutor, demo: DemoSeed, config: AppConfig): Promise<SeedReport[]> {
  const encryption = new EncryptionService(config);
  const tokens = new TokenService(config);
  const merchants = demoRows<{ id: string; name: string }>(demo, 'merchants').slice(0, 4);
  const endpoints = merchants.map((merchant, index) => ({
    id: index + 1,
    clientId: demoNumericId(merchant.id),
    name: merchant.name,
    url: `https://hooks.${merchant.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.example/gsm`,
  }));
  const endpointReport = await insertRows(
    db,
    s.webhookEndpoints,
    endpoints.map((endpoint) => ({
      id: endpoint.id,
      clientId: endpoint.clientId,
      url: endpoint.url,
      secretEnc: encryption.encrypt(`whsec_seed_${endpoint.id}_development_only`, WEBHOOK_SECRET_AAD),
      events: [...SEED_EVENTS],
      isActive: true,
      failureCount: 0,
    })),
  );
  const deliveries = Array.from({ length: 36 }, (_, index) => {
    const endpoint = endpoints[index % endpoints.length]!;
    const event = SEED_EVENTS[index % SEED_EVENTS.length]!;
    const at = new Date(demo.now - (index + 1) * 25 * MINUTE_MS);
    const eventId = `evt_${tokens.hash(`seed-delivery:${index}`).slice(0, 24)}`;
    const kind = index % 9 === 2 ? 'refused' : index % 9 === 5 ? 'silent' : index % 9 === 7 ? 'waiting' : 'delivered';
    return {
      id: 36 - index,
      endpointId: endpoint.id,
      event,
      eventId,
      payload: { id: eventId, type: event, createdAt: at.toISOString(), data: { orderId: 48100 - index } },
      // A failed delivery used its 8 attempts; a waiting one is on its 2nd to 4th.
      attempt: kind === 'delivered' ? 1 : kind === 'waiting' ? 2 + (index % 3) : 8,
      status:
        kind === 'delivered' ? ('delivered' as const) : kind === 'waiting' ? ('pending' as const) : ('failed' as const),
      responseCode: kind === 'refused' ? 500 : kind === 'delivered' ? 200 : null,
      responseBody: kind === 'refused' ? '{"error":"internal"}' : kind === 'delivered' ? '{"ok":true}' : null,
      error: kind === 'silent' ? 'The endpoint did not answer within 10 seconds.' : null,
      nextRetryAt: kind === 'waiting' ? new Date(demo.now + (index + 1) * MINUTE_MS) : null,
      createdAt: at,
    };
  });
  const deliveryReport = await insertRows(db, s.webhookDeliveries, deliveries);
  await syncIdentity(db, s.webhookEndpoints);
  await syncIdentity(db, s.webhookDeliveries);
  return [endpointReport, deliveryReport];
}
