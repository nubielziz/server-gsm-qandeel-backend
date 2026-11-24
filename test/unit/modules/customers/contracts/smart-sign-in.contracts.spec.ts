// Unit tests of the one sign-in route contract (decision 064): the answer carries the rank, `kind` stays for the shop of the time before
// accounts became one, and the route needs the anti-bot token always.
import { describe, expect, it } from 'bun:test';
import { smartSignIn } from '@src/modules/customers/contracts/smart-sign-in.contracts';

describe('POST /client/auth/sign-in', () => {
  const merchant = { kind: 'merchant', next: 'done', rank: { id: 1, name: 'Standard', kind: 'merchant' } };

  it('answers the area word, the next step and the rank', () => {
    const schema = smartSignIn.success.schema;
    expect(schema.safeParse(merchant).success).toBe(true);
    expect(
      schema.safeParse({ kind: 'customer', next: 'totp', rank: { id: 4, name: 'Retail', kind: 'retail' } }).success,
    ).toBe(true);
    expect(schema.safeParse({ kind: 'merchant', next: 'done' }).success).toBe(false);
    expect(schema.safeParse({ ...merchant, rank: { id: 1, name: 'Standard', kind: 'b2b' } }).success).toBe(false);
  });

  it('documents an example its own schema accepts', () => {
    expect(smartSignIn.success.schema.safeParse(smartSignIn.examples.response).success).toBe(true);
  });

  it('needs the anti-bot token on every call, whatever the rollout switch says', () => {
    expect(smartSignIn.turnstile).toBe(true);
    expect(smartSignIn.turnstileRollout).toBeUndefined();
    expect(smartSignIn.access).toBe('public');
  });
});
