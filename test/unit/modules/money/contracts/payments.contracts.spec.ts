// Unit tests of the query of `GET /admin/payments` (decision 064): the filters that name an account, the alias `clientId`, the retired
// `customerId` (an unknown parameter, so 422) and the owner words. The route's own contract is read; nothing else loads.
import { describe, expect, it } from 'bun:test';
import { describeListQuery } from '@src/common/contract';
import { listPayments } from '@src/modules/money/contracts/payments.contracts';
import { TOP_UP_OWNER_WORDS } from '@src/modules/money/domain/payment-rules';

const query = listPayments.query;
const parse = (raw: Record<string, unknown>) => query.safeParse(raw);

describe('the query of GET /admin/payments', () => {
  it('declares accountId and its alias clientId as one exact id filter each, and no customerId', () => {
    const filters = describeListQuery(query).filters;
    expect(Object.keys(filters)).toEqual(
      expect.arrayContaining(['accountId', 'clientId', 'owner', 'status', 'purpose']),
    );
    expect(filters.accountId).toMatchObject({ type: 'id', ops: ['eq'] });
    expect(filters.clientId).toMatchObject({ type: 'id', ops: ['eq'] });
    expect(filters).not.toHaveProperty('customerId');
  });

  it('keeps the owner words of the wire: merchant and customer', () => {
    expect(describeListQuery(query).filters.owner).toMatchObject({ type: 'enum', values: [...TOP_UP_OWNER_WORDS] });
  });

  it('parses accountId and clientId to the same filter value', () => {
    for (const field of ['accountId', 'clientId']) {
      const parsed = parse({ [field]: '41' });
      expect(parsed.success, field).toBe(true);
      expect(parsed.data?.filters).toEqual([{ field, op: 'eq', values: [41] }]);
    }
  });

  it('refuses the retired customerId as an unknown parameter, with its name in the problem', () => {
    const parsed = parse({ customerId: '41' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('customerId');
  });

  it('refuses an owner word it does not know', () => {
    expect(parse({ owner: 'client' }).success).toBe(false);
    expect(parse({ owner: 'merchant' }).success).toBe(true);
    expect(parse({ owner: 'customer' }).success).toBe(true);
  });
});
