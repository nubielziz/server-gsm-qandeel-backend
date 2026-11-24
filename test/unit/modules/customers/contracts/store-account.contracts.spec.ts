// Unit tests of the retail account's route contracts (decision 064): `GET /store/v1/me` answers the same `AccountMe` keys as
// `GET /client/auth/me`, with an empty username and company for a retail account, and the list of shop orders keeps its shape.
import { describe, expect, it } from 'bun:test';
import { ACCOUNT_ME_EXAMPLE, AccountMeShape } from '@src/modules/identity/contracts/merchant-auth.contracts';
import {
  STORE_ME_EXAMPLE,
  StoreMeSchema,
  getMe,
  listMyOrders,
  updateMe,
} from '@src/modules/customers/contracts/store-account.contracts';

describe('StoreMeSchema', () => {
  it('has the same keys as the merchant route (AccountMeShape), and the same rank keys', () => {
    expect(Object.keys(StoreMeSchema.shape).sort()).toEqual(Object.keys(AccountMeShape.shape).sort());
    expect(Object.keys(StoreMeSchema.shape.rank.shape).sort()).toEqual(
      Object.keys(AccountMeShape.shape.rank.shape).sort(),
    );
  });

  it('has the same statuses and rank kinds as the merchant route', () => {
    expect([...StoreMeSchema.shape.status.options].sort()).toEqual([...AccountMeShape.shape.status.options].sort());
    expect([...StoreMeSchema.shape.rank.shape.kind.options].sort()).toEqual(
      [...AccountMeShape.shape.rank.shape.kind.options].sort(),
    );
  });

  it('has examples with the same keys, and the retail one has no username and no company', () => {
    expect(Object.keys(STORE_ME_EXAMPLE).sort()).toEqual(Object.keys(ACCOUNT_ME_EXAMPLE).sort());
    expect(StoreMeSchema.safeParse(STORE_ME_EXAMPLE).success).toBe(true);
    expect(STORE_ME_EXAMPLE.rank.kind).toBe('retail');
    expect(STORE_ME_EXAMPLE.username).toBe('');
    expect(STORE_ME_EXAMPLE.company).toBe('');
  });
});

describe('the retail account routes', () => {
  it('serve the retail rank only (the default of a customer session route)', () => {
    expect(getMe.rank).toBe('retail');
    expect(updateMe.rank).toBe('retail');
    expect(listMyOrders.rank).toBe('retail');
  });

  it('answer AccountMe on the read and on the edit', () => {
    expect(getMe.success.schema).toBe(StoreMeSchema);
    expect(updateMe.success.schema).toBe(StoreMeSchema);
  });

  it('list the shop orders as a page', () => {
    expect(listMyOrders.success.list).toBe(true);
  });
});
