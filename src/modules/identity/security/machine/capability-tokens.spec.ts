// Unit tests of the capability token guard: where the token is read from, which tokens never reach a resolver, the answers for a
// token that opens nothing, and the registry.
import { describe, expect, it } from 'bun:test';
import type { FastifyRequest } from 'fastify';
import type { AnyRouteContract } from '../../../../common/contract';
import {
  CAPABILITY_ACCESS_KINDS,
  CapabilityAccessHandler,
  CapabilityTokenResolvers,
  type CapabilityTokenResolver,
  capabilityRefusal,
  capabilityTokenOf,
} from './capability-tokens';
import { rejectionOf } from '../../../../../test/support/rejection';

const TOKEN = 'aBcDeFgHiJkLmNoPqRsTuV';
const contract = {} as AnyRouteContract;
const requestWith = (params: unknown, body?: unknown, ip = '203.0.113.9') =>
  ({ params, body, ip }) as unknown as FastifyRequest;

describe('capabilityTokenOf', () => {
  it('reads the token path parameter, or else the token field of the body', () => {
    expect(capabilityTokenOf({ params: { token: TOKEN }, body: undefined })).toBe(TOKEN);
    expect(capabilityTokenOf({ params: {}, body: { token: TOKEN } })).toBe(TOKEN);
    expect(capabilityTokenOf({ params: { token: TOKEN }, body: { token: 'b'.repeat(22) } })).toBe(TOKEN);
  });

  it('reads nothing that cannot be one of our tokens: too short or long, other characters, not text', () => {
    for (const token of [
      '',
      'short',
      'x'.repeat(15),
      'x'.repeat(129),
      'has space in it 123',
      'semi;colon-123456789',
      42,
      null,
      ['a'],
      {},
    ]) {
      expect(capabilityTokenOf({ params: { token }, body: undefined }), JSON.stringify(token)).toBeUndefined();
      expect(capabilityTokenOf({ params: {}, body: { token } }), JSON.stringify(token)).toBeUndefined();
    }
    expect(capabilityTokenOf({ params: undefined, body: undefined })).toBeUndefined();
    expect(capabilityTokenOf({ params: null, body: 'a string body' })).toBeUndefined();
    expect(capabilityTokenOf({ params: {}, body: [TOKEN] })).toBeUndefined();
  });

  it('accepts the shortest and the longest token of the shape', () => {
    expect(capabilityTokenOf({ params: { token: 'x'.repeat(16) }, body: undefined })).toBe('x'.repeat(16));
    expect(capabilityTokenOf({ params: { token: 'x'.repeat(128) }, body: undefined })).toBe('x'.repeat(128));
  });
});

describe('capabilityRefusal', () => {
  it('is 410 TOKEN_INVALID for a sign-in link and 404 NOT_FOUND for the other tokens, never a 401', () => {
    expect(capabilityRefusal('link-token')).toMatchObject({ code: 'TOKEN_INVALID', status: 410 });
    for (const kind of ['checkout-token', 'tracking-token', 'ticket-token'] as const) {
      expect(capabilityRefusal(kind), kind).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    }
  });
});

describe('CapabilityTokenResolvers', () => {
  const resolver = (kind: CapabilityTokenResolver['kind'], id: number | null): CapabilityTokenResolver => ({
    kind,
    resolve: () => (id === null ? null : { id }),
  });

  it('keeps one resolver per kind', () => {
    const registry = new CapabilityTokenResolvers();
    expect(registry.has('checkout-token')).toBe(false);
    registry.register(resolver('checkout-token', 1));
    expect(registry.has('checkout-token')).toBe(true);
    expect(() => registry.register(resolver('checkout-token', 2))).toThrow(/already registered/);
    registry.register(resolver('tracking-token', 3));
  });

  it('resolves through the resolver of the kind, an asynchronous one too', async () => {
    const registry = new CapabilityTokenResolvers();
    registry.register({ kind: 'ticket-token', resolve: (token) => Promise.resolve({ id: token.length }) });
    expect(await registry.resolve('ticket-token', TOKEN)).toEqual({ id: TOKEN.length });
  });

  it('answers null for a token that opens nothing, and for a kind without a resolver', async () => {
    const registry = new CapabilityTokenResolvers();
    registry.register(resolver('tracking-token', null));
    expect(await registry.resolve('tracking-token', TOKEN)).toBeNull();
    expect(await registry.resolve('checkout-token', TOKEN)).toBeNull();
  });

  it("lets a failing resolver's error through", async () => {
    const registry = new CapabilityTokenResolvers();
    registry.register({ kind: 'link-token', resolve: () => Promise.reject(new Error('database is down')) });
    expect(await rejectionOf(registry.resolve('link-token', TOKEN))).toMatchObject({ message: 'database is down' });
  });

  it('covers the four storefront token kinds', () => {
    expect([...CAPABILITY_ACCESS_KINDS].sort()).toEqual([
      'checkout-token',
      'link-token',
      'ticket-token',
      'tracking-token',
    ]);
  });
});

describe('CapabilityAccessHandler', () => {
  const handlerFor = (kind: CapabilityTokenResolver['kind'], id: number | null) => {
    const registry = new CapabilityTokenResolvers();
    const asked: string[] = [];
    registry.register({
      kind,
      resolve: (token) => {
        asked.push(token);
        return id === null ? null : { id };
      },
    });
    return { handler: new CapabilityAccessHandler(kind, registry), asked };
  };

  it('answers a principal with the id the resolver found and the address of the caller', async () => {
    const { handler, asked } = handlerFor('checkout-token', 55);
    const state = await handler.authenticate(requestWith({ token: TOKEN }), contract);
    expect(state.principal).toEqual({
      kind: 'capability',
      access: 'checkout-token',
      resourceId: 55,
      ip: '203.0.113.9',
    });
    expect(asked).toEqual([TOKEN]);
  });

  it('does not ask the resolver about a token of the wrong shape', async () => {
    const { handler, asked } = handlerFor('tracking-token', 1);
    expect(await rejectionOf(handler.authenticate(requestWith({ token: 'nope' }), contract))).toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await rejectionOf(handler.authenticate(requestWith({}), contract))).toMatchObject({ code: 'NOT_FOUND' });
    expect(asked).toEqual([]);
  });

  it('refuses a token that opens nothing in the words of its kind', async () => {
    expect(
      await rejectionOf(
        handlerFor('link-token', null).handler.authenticate(requestWith({}, { token: TOKEN }), contract),
      ),
    ).toMatchObject({ code: 'TOKEN_INVALID', status: 410 });
    expect(
      await rejectionOf(handlerFor('ticket-token', null).handler.authenticate(requestWith({ token: TOKEN }), contract)),
    ).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });
});
