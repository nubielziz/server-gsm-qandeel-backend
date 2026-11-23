// Integration tests of who a storefront receipt names (GET /store/v1/orders/:token/receipt, the `receipt.render` job): the receipt is
// handed to whoever holds the order's tracking link, so it prints the account's stored name only when the account itself opened the
// checkout signed in; a guest checkout prints the address the checkout was opened with and no stored name, whoever that address belongs to.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { type Database } from '@src/infra/db';
import { ReceiptRenderModule } from '@src/modules/money';
import { PdfRenderer } from '@src/modules/platform';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  B2cGateway,
  type B2cWorld,
  b2cWorld,
  hook,
  json,
  paidOrder,
  pay,
  renderReceipts,
  storefrontEvent,
} from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { openSignedInCheckout } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { freshClientIp } from '../../support/pipeline-routes';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({
    clock,
    imports: [GatewayTestModule, ReceiptRenderModule],
    env: { SHOP_ORIGINS: STORE_ORIGIN },
  });
});
beforeEach(async () => {
  clock.set('2026-11-10T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  world = await b2cWorld(t, db, fake);
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});

/** A card-paid order of a checkout the signed-in account opened itself. */
async function paidSignedInOrder(client: StoreClient, email: string): Promise<{ trackingToken: string }> {
  const { token } = await openSignedInCheckout(client, world, email);
  const started = await pay(t, token, undefined);
  expect(started.statusCode).toBe(201);
  const { payment } = json(started);
  const id = crypto.randomUUID().slice(0, 8);
  const body = storefrontEvent(`evt_signed_${id}`, payment.reference, {
    amount: payment.amount,
    currency: payment.currency,
    intent: `pi_signed_${id}`,
  });
  expect((await hook(t, clock, 'payments', world.gateway.code, body)).statusCode).toBe(200);
  const shown = json(
    await t.app.inject({ method: 'GET', url: `/store/v1/checkout-sessions/${token}`, remoteAddress: freshClientIp() }),
  );
  expect(shown.status).toBe('paid');
  return { trackingToken: shown.trackingToken as string };
}

/** Draws the receipts the captures queued and downloads one by its tracking link; returns its facts as drawn. */
async function drawnFacts(trackingToken: string): Promise<{ facts: Map<string, string>; drawn: string }> {
  const render = spyOn(PdfRenderer.prototype, 'render');
  try {
    expect((await renderReceipts(t)).length).toBeGreaterThan(0);
    const receipt = await t.app.inject({
      method: 'GET',
      url: `/store/v1/orders/${trackingToken}/receipt`,
      remoteAddress: freshClientIp(),
    });
    expect(receipt.statusCode).toBe(200);
    const documents = render.mock.calls.map((call) => call[0]);
    expect(documents).toHaveLength(1);
    const block = documents[0]!.blocks.find((b) => b.kind === 'facts');
    const rows = block?.kind === 'facts' ? block.rows : [];
    return { facts: new Map(rows.map(([label, value]) => [label, value])), drawn: JSON.stringify(documents) };
  } finally {
    render.mockRestore();
  }
}

describe('who a storefront receipt names', () => {
  it('names the address a guest checkout was opened with, never the stored name of the account that address belongs to', async () => {
    const holder = await makeCustomer(t, { email: 'valerie.private@mail.example', name: 'Valerie Quillfeather' });
    const paid = await paidOrder(t, clock, world, { email: holder.email });
    const { facts, drawn } = await drawnFacts(paid.trackingToken);
    expect(facts.get('Billed to')).toBe('valerie.private@mail.example');
    expect(facts.get('Email')).toBe('valerie.private@mail.example');
    expect(drawn).not.toContain('Valerie Quillfeather');
  });

  it('names the account holder when the account opened the checkout signed in', async () => {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login(customer.email)).statusCode).toBe(200);
    const paid = await paidSignedInOrder(client, customer.email);
    const { facts } = await drawnFacts(paid.trackingToken);
    expect(facts.get('Billed to')).toBe('Daniel Rivera');
    expect(facts.get('Email')).toBe(customer.email);
  });
});
