// Unit tests of the webhook adapter registry: slugs, one adapter per gateway, lookups that cannot be tricked.
import { describe, expect, it } from 'bun:test';
import { GATEWAY_SLUG, type WebhookVerifier, WebhookVerifiers } from './webhook-verifiers';

const adapter = (gateway: string): WebhookVerifier => ({ gateway, verify: () => ({ eventId: 'e', timestamp: 1 }) });

describe('WebhookVerifiers', () => {
  it('registers one adapter per gateway and lists them sorted', () => {
    const registry = new WebhookVerifiers();
    registry.register(adapter('wise'));
    registry.register(adapter('stripe'));
    expect(registry.gateways()).toEqual(['stripe', 'wise']);
    expect(registry.get('wise')?.gateway).toBe('wise');
    expect(registry.get('paypal')).toBeUndefined();
    expect(() => registry.register(adapter('wise'))).toThrow(/already registered/);
  });

  it('refuses a slug that is not lower case letters, digits, underscore and dash', () => {
    const registry = new WebhookVerifiers();
    for (const slug of ['', 'Stripe', 'my gateway', 'a/b', 'a:b', '-leading', 'x'.repeat(41), '../etc']) {
      expect(() => registry.register(adapter(slug)), slug).toThrow(/not a valid gateway slug/);
    }
    expect(() => registry.register(adapter('pay_pal-2'))).not.toThrow();
  });

  it('finds nothing for a slug that is not valid, even if its text matches a registered key some other way', () => {
    const registry = new WebhookVerifiers();
    registry.register(adapter('stripe'));
    for (const slug of ['STRIPE', 'stripe ', '__proto__', 'constructor', ''])
      expect(registry.get(slug), slug).toBeUndefined();
    expect(GATEWAY_SLUG.test('stripe')).toBe(true);
  });
});

describe('WebhookVerifiers resolver', () => {
  it('asks the resolver only for a valid slug that has no registered adapter, and sets it once', async () => {
    const registry = new WebhookVerifiers();
    registry.register(adapter('wise'));
    const asked: string[] = [];
    registry.setResolver((slug) => {
      asked.push(slug);
      return slug === 'card' ? adapter('card') : undefined;
    });
    expect((await registry.resolve('wise'))?.gateway).toBe('wise');
    expect((await registry.resolve('card'))?.gateway).toBe('card');
    expect(await registry.resolve('nope')).toBeUndefined();
    expect(await registry.resolve('Bad Slug')).toBeUndefined();
    expect(asked).toEqual(['card', 'nope']);
    expect(() => registry.setResolver(() => undefined)).toThrow(/already set/);
  });

  it('answers nothing for an unknown slug when no resolver is set', async () => {
    expect(await new WebhookVerifiers().resolve('card')).toBeUndefined();
  });
});
