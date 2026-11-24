// Unit tests of the route contracts of /admin/clients and of the legacy lookup (decision 064): what the list accepts, what a create and an
// edit take, and what they refuse before any use case runs.
import { describe, expect, it } from 'bun:test';
import {
  countClients,
  createClient,
  listClients,
  showClient,
  updateClient,
} from '@src/modules/identity/contracts/clients.contracts';
import { findLegacyAccount } from '@src/modules/identity/contracts/legacy-accounts.contracts';

const list = (raw: Record<string, unknown>) => listClients.query.safeParse(raw);
const filterOf = (raw: Record<string, unknown>, field: string) =>
  list(raw).data?.filters.filter((filter) => filter.field === field);

describe('GET /admin/clients, the query', () => {
  it('lists every account when no filter is sent: there is no merchant-only default', () => {
    const parsed = list({});
    expect(parsed.success).toBe(true);
    expect(parsed.data?.filters).toEqual([]);
    expect(parsed.data?.sort).toEqual([{ field: 'name', order: 'asc' }]);
    expect(parsed.data?.range).toEqual({ start: 0, end: 25, limit: 25 });
  });

  it('takes rankKind once or repeated, and only retail or merchant', () => {
    expect(filterOf({ rankKind: ['retail', 'merchant'] }, 'rankKind')).toEqual([
      { field: 'rankKind', op: 'eq', values: ['retail', 'merchant'] },
    ]);
    expect(list({ rankKind: 'retail' }).success).toBe(true);
    for (const kind of ['b2b', 'b2c_retail', 'guest']) expect(list({ rankKind: kind }).success, kind).toBe(false);
  });

  it('takes the four statuses, repeated for an IN, and refuses the retired pending', () => {
    expect(filterOf({ status: ['suspended', 'blocked'] }, 'status')).toEqual([
      { field: 'status', op: 'eq', values: ['suspended', 'blocked'] },
    ]);
    expect(list({ status_ne: 'anonymized' }).success).toBe(true);
    for (const status of ['pending', 'flagged']) expect(list({ status }).success, status).toBe(false);
  });

  it('takes hasAccount and invitationPending as booleans, rankId as an id and country as text', () => {
    expect(filterOf({ hasAccount: 'false' }, 'hasAccount')?.[0]?.values).toEqual([false]);
    expect(filterOf({ invitationPending: 'true' }, 'invitationPending')?.[0]?.values).toEqual([true]);
    expect(filterOf({ rankId: '3' }, 'rankId')?.[0]?.values).toEqual([3]);
    expect(filterOf({ country: 'JO' }, 'country')?.[0]?.values).toEqual(['JO']);
    expect(list({ hasAccount: 'maybe' }).success).toBe(false);
    expect(list({ rankId: 'x' }).success).toBe(false);
  });

  it('no longer takes the group keys of the merchant list', () => {
    expect(list({ groupId: '3' }).success).toBe(false);
    expect(list({ _sort: 'groupId' }).success).toBe(false);
  });

  it('sorts by the nine fields, in either direction', () => {
    for (const field of [
      'name',
      'createdAt',
      'id',
      'status',
      'country',
      'rank',
      'ordersCount',
      'lastOrderAt',
      'balance',
    ] as const) {
      expect(list({ _sort: field, _order: 'desc' }).data?.sort, field).toEqual([{ field, order: 'desc' }]);
    }
    expect(list({ _sort: 'email' }).success).toBe(false);
  });

  it('searches name, email, company and username', () => {
    expect(list({ q: 'alpha' }).data?.search).toEqual({
      text: 'alpha',
      fields: ['name', 'email', 'company', 'username'],
    });
  });
});

describe('the other reads', () => {
  it('count accounts and show one with the same permission', () => {
    expect(countClients.key).toBe('GET /admin/clients/counts');
    expect(countClients.permission).toBe('clients:read');
    expect(showClient.permission).toBe('clients:read');
    expect(listClients.permission).toBe('clients:read');
  });

  it('answer the counts as whole numbers, one per chip', () => {
    const counts = {
      all: 6,
      retail: 4,
      merchant: 2,
      guests: 1,
      active: 3,
      suspended: 1,
      blocked: 1,
      anonymized: 1,
      invitationPending: 1,
    };
    expect(countClients.success.schema.safeParse(counts).success).toBe(true);
    expect(countClients.success.schema.safeParse({ ...counts, guests: 1.5 }).success).toBe(false);
    expect(countClients.success.schema.safeParse({ ...counts, all: undefined }).success).toBe(false);
  });
});

describe('POST /admin/clients, the body', () => {
  const body = { name: 'Zain Mobile Hub', email: 'Ops@ZainMobileHub.example', country: 'jo' };

  it('cleans the name, the email and the country, and sends a reset link unless told otherwise', () => {
    const parsed = createClient.body.safeParse(body);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      name: 'Zain Mobile Hub',
      email: 'ops@zainmobilehub.example',
      country: 'JO',
      password: { mode: 'reset_link' },
    });
  });

  it('takes a temporary password, a rank, a company and a credit limit', () => {
    const parsed = createClient.body.safeParse({
      ...body,
      groupId: 3,
      company: 'Zain Co',
      creditLimit: '500.0000',
      password: { mode: 'temporary_password' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.password.mode).toBe('temporary_password');
  });

  it('refuses a bad country, an unknown mode and a credit limit that is not money', () => {
    expect(createClient.body.safeParse({ ...body, country: 'Jordan' }).success).toBe(false);
    expect(createClient.body.safeParse({ ...body, password: { mode: 'invite' } }).success).toBe(false);
    expect(createClient.body.safeParse({ ...body, creditLimit: '500' }).success).toBe(false);
  });

  it('answers 201 with the account row and the temporary password once', () => {
    expect(createClient.success.status).toBe(201);
    const example = createClient.examples?.response as Record<string, unknown>;
    expect(createClient.success.schema.safeParse({ ...example, temporaryPassword: 'Kq7mT2vNb8RxHc' }).success).toBe(
      true,
    );
  });
});

describe('PATCH /admin/clients/:id, the body', () => {
  const parse = (raw: unknown) => updateClient.body.safeParse(raw);

  it('takes a status of active or suspended, and details', () => {
    expect(parse({ status: 'active' }).success).toBe(true);
    expect(parse({ status: 'suspended', reason: 'Chargebacks' }).success).toBe(true);
    expect(parse({ name: 'New name', phone: '+962 7 0000 0000', country: 'ae' }).data).toMatchObject({ country: 'AE' });
  });

  it('refuses blocked, anonymized and pending as a status: they have their own routes or are gone', () => {
    for (const status of ['blocked', 'anonymized', 'pending']) expect(parse({ status }).success, status).toBe(false);
  });

  it('refuses an empty body and a reason alone', () => {
    expect(parse({}).success).toBe(false);
    expect(parse({ reason: 'because' }).success).toBe(false);
  });

  it('lets a groupId through to the route, which answers 422 use_rank_route', () => {
    expect(parse({ groupId: 3 }).success).toBe(true);
  });
});

describe('GET /admin/legacy-accounts/:type/:id', () => {
  const parse = (raw: unknown) => findLegacyAccount.params.safeParse(raw);

  it('reads the old number as a number and keeps the type as text', () => {
    expect(parse({ type: 'customer', id: '7' }).data).toEqual({ type: 'customer', id: 7 });
  });

  it('refuses an id that is not a positive whole number', () => {
    for (const id of ['0', '-1', '1.5', 'x', '']) expect(parse({ type: 'customer', id }).success, id).toBe(false);
  });

  it('answers the account id and nothing else', () => {
    expect(findLegacyAccount.success.schema.safeParse({ accountId: 131 }).success).toBe(true);
    expect(findLegacyAccount.success.schema.safeParse({ accountId: 131, id: 7 }).data).toEqual({ accountId: 131 });
    expect(findLegacyAccount.permission).toBe('clients:read');
  });
});
