// Unit tests of the gateway webhook guard with fake adapters and a fake replay filter: the order signature, window, replay filter,
// the 5 minute edges, what a repeat looks like, and when an event is forgotten.
import { EventEmitter } from 'node:events';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import type { AnyRouteContract } from '../../../../../common/contract';
import { AppError } from '../../../../../common/errors';
import { GatewaySignatureAccessHandler } from './gateway-signature.handler';
import type { EventClaim, WebhookEventLedger } from './webhook-event-ledger';
import { type VerifiedDelivery, type WebhookDelivery, WebhookVerifiers } from './webhook-verifiers';
import { TestClock } from '../../../../../../test/support/clock';
import { rejectionOf } from '../../../../../../test/support/rejection';

const contract = {} as AnyRouteContract;
/** The handler's clock: fixed, so the 5 minute edges are exact. */
const clock = new TestClock('2026-11-01T10:00:00.000Z');
const now = () => Math.floor(clock.nowMs() / 1000);

interface Reply {
  readonly raw: EventEmitter;
  statusCode: number;
}

function setup(options: { verify?: (delivery: WebhookDelivery) => VerifiedDelivery; claim?: EventClaim } = {}) {
  const seen: WebhookDelivery[] = [];
  const claimed: string[] = [];
  const released: string[] = [];
  const verifiers = new WebhookVerifiers();
  verifiers.register({
    gateway: 'pay',
    verify: (delivery) => {
      seen.push(delivery);
      return options.verify ? options.verify(delivery) : { eventId: 'evt_1', timestamp: now() };
    },
  });
  const ledger = {
    claim: (gateway: string, eventId: string) => {
      claimed.push(`${gateway}/${eventId}`);
      return Promise.resolve(options.claim ?? 'new');
    },
    release: (gateway: string, eventId: string) => {
      released.push(`${gateway}/${eventId}`);
      return Promise.resolve();
    },
  } as unknown as WebhookEventLedger;
  const reply: Reply = { raw: new EventEmitter(), statusCode: 200 };
  const context = { switchToHttp: () => ({ getResponse: () => reply }) } as unknown as ExecutionContext;
  return {
    handler: new GatewaySignatureAccessHandler(verifiers, ledger, clock),
    seen,
    claimed,
    released,
    reply,
    context,
  };
}

const post = (gateway: unknown, body: unknown = undefined) =>
  ({ params: { gateway }, headers: { 'x-sig': 'abc' }, body, ip: '198.51.100.4' }) as unknown as FastifyRequest;

describe('GatewaySignatureAccessHandler', () => {
  it('hands the adapter the gateway, the headers, the bytes of the body and the clock', async () => {
    const s = setup();
    await s.handler.authenticate(post('pay'), contract, s.context);
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]).toMatchObject({ gateway: 'pay', headers: { 'x-sig': 'abc' } });
    expect(s.seen[0]!.rawBody.length).toBe(0);
    expect(s.seen[0]!.nowSeconds).toBe(now());
  });

  it('answers a webhook principal for a delivery that is verified, recent and new', async () => {
    const at = now();
    const fresh = setup({ verify: () => ({ eventId: 'evt_9', timestamp: at }) });
    const state = await fresh.handler.authenticate(post('pay'), contract, fresh.context);
    expect(state.principal).toEqual({
      kind: 'webhook',
      gateway: 'pay',
      eventId: 'evt_9',
      timestamp: at,
      duplicate: false,
      ip: '198.51.100.4',
    });
    expect(fresh.claimed).toEqual(['pay/evt_9']);
  });

  it('refuses a gateway without an adapter, a slug that is not valid and a request without the gateway parameter', async () => {
    const s = setup();
    for (const gateway of ['unknown', 'bad slug', '', 'x'.repeat(50), undefined, 5]) {
      expect(
        await rejectionOf(s.handler.authenticate(post(gateway), contract, s.context)),
        String(gateway),
      ).toMatchObject({
        code: 'WEBHOOK_SIGNATURE_INVALID',
        status: 400,
      });
    }
    expect(s.seen).toEqual([]);
    expect(s.claimed).toEqual([]);
  });

  it('ignores the case of the slug', async () => {
    const s = setup();
    expect((await s.handler.authenticate(post('PAY'), contract, s.context)).principal).toMatchObject({
      gateway: 'pay',
    });
  });

  it("lets the adapter's refusal through and never reaches the replay filter after it", async () => {
    const s = setup({
      verify: () => {
        throw new AppError('WEBHOOK_SIGNATURE_INVALID', { detail: 'mismatch' });
      },
    });
    expect(await rejectionOf(s.handler.authenticate(post('pay'), contract, s.context))).toMatchObject({
      detail: 'mismatch',
    });
    expect(s.claimed).toEqual([]);
  });

  it('accepts a signed time within 5 minutes of now and refuses one beyond, in the past and in the future', async () => {
    for (const [offset, accepted] of [
      [-299, true],
      [299, true],
      [-302, false],
      [302, false],
      [-86_400, false],
    ] as const) {
      const s = setup({ verify: () => ({ eventId: 'evt', timestamp: now() + offset }) });
      const result = s.handler.authenticate(post('pay'), contract, s.context);
      if (accepted) expect(await result, String(offset)).toBeDefined();
      else expect(await rejectionOf(result), String(offset)).toMatchObject({ code: 'WEBHOOK_SIGNATURE_INVALID' });
      // A delivery outside the window never marks its event.
      expect(s.claimed.length, String(offset)).toBe(accepted ? 1 : 0);
    }
  });

  it('marks a repeat as a duplicate instead of refusing it', async () => {
    const s = setup({ claim: 'duplicate' });
    const state = await s.handler.authenticate(post('pay'), contract, s.context);
    expect(state.principal).toMatchObject({ kind: 'webhook', duplicate: true });
  });

  it('treats a delivery as new when the replay filter is unavailable', async () => {
    const s = setup({ claim: 'unavailable' });
    expect((await s.handler.authenticate(post('pay'), contract, s.context)).principal).toMatchObject({
      duplicate: false,
    });
  });

  it('forgets a new event when the reply ends with a server error, and keeps it after a success or a client error', async () => {
    for (const [status, forgotten] of [
      [500, true],
      [503, true],
      [200, false],
      [400, false],
      [422, false],
    ] as const) {
      const s = setup();
      await s.handler.authenticate(post('pay'), contract, s.context);
      s.reply.statusCode = status;
      s.reply.raw.emit('finish');
      expect(s.released, String(status)).toEqual(forgotten ? ['pay/evt_1'] : []);
    }
  });

  it("does not forget an event it did not mark itself: a duplicate's failure leaves the first delivery's mark", async () => {
    const s = setup({ claim: 'duplicate' });
    await s.handler.authenticate(post('pay'), contract, s.context);
    s.reply.statusCode = 500;
    s.reply.raw.emit('finish');
    expect(s.released).toEqual([]);
  });

  it('fails with 500 when the adapter returns no usable event id or time', async () => {
    for (const verified of [
      { eventId: '', timestamp: now() },
      { eventId: 'x'.repeat(257), timestamp: now() },
      { eventId: 'evt', timestamp: Number.NaN },
      { eventId: undefined as unknown as string, timestamp: now() },
    ]) {
      const s = setup({ verify: () => verified });
      expect(await rejectionOf(s.handler.authenticate(post('pay'), contract, s.context))).toMatchObject({
        code: 'INTERNAL_ERROR',
      });
    }
  });

  it('fails with 500 when the request has a body but the raw bytes were not kept', async () => {
    const s = setup();
    expect(await rejectionOf(s.handler.authenticate(post('pay', { id: 'evt' }), contract, s.context))).toMatchObject({
      code: 'INTERNAL_ERROR',
    });
    expect(s.seen).toEqual([]);
  });
});
