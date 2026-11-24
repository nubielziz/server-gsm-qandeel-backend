// Unit tests of the data request route contracts (decision 064): the two privacy routes are open to every rank, the staff list filters by
// account and refuses the retired customer filter, and a row names its account. No database.
import { describe, expect, it } from 'bun:test';
import {
  DataRequestSchema,
  listDataRequests,
  requestMyDataErasure,
  requestMyDataExport,
} from '@src/modules/risk/contracts/data-requests.contracts';

describe('the two privacy routes of an account', () => {
  it('are open to every rank, so the rank gate lets a merchant rank through', () => {
    expect(requestMyDataExport.rank).toBe('any');
    expect(requestMyDataErasure.rank).toBe('any');
  });

  it('never answer the rank refusal; only the erasure answers the merchant-rank conflict', () => {
    expect(requestMyDataExport.errors).not.toContain('RANK_NOT_ALLOWED');
    expect(requestMyDataErasure.errors).not.toContain('RANK_NOT_ALLOWED');
    expect(requestMyDataExport.errors).not.toContain('CONFLICT');
    expect(requestMyDataErasure.errors).toContain('CONFLICT');
  });

  it('stay on the shop surface with the customer-session access name', () => {
    for (const route of [requestMyDataExport, requestMyDataErasure]) {
      expect(route.surface).toBe('store');
      expect(route.access).toBe('customer-session');
    }
  });
});

describe('GET /admin/data-requests', () => {
  it('names the account of a row and no customer', () => {
    const keys = Object.keys(DataRequestSchema.shape);
    expect(keys).toContain('accountId');
    expect(keys).toContain('accountName');
    expect(keys).not.toContain('customerId');
    expect(keys).not.toContain('customerName');
  });

  it('filters by accountId, and refuses the retired customerId filter', () => {
    const query = listDataRequests.query;
    expect(query.safeParse({ accountId: '4' }).success).toBe(true);
    expect(query.safeParse({ customerId: '4' }).success).toBe(false);
  });
});
