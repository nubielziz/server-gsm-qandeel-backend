// Tests of the pure comparisons between route contracts and the route manifest (decision 035), with hand-written rows and contracts.
import { describe, expect, it } from 'bun:test';
import type { ManifestEndpoint } from './inputs';
import {
  type AccessException,
  type ContractRow,
  accessMismatches,
  difference,
  expectedKeys,
  rowMismatches,
  staleAccessExceptions,
  turnstileMismatches,
} from './manifest-parity';

/** A manifest row with the fields these comparisons read. */
function row(key: string, extra: Partial<ManifestEndpoint> = {}): ManifestEndpoint {
  const [method = 'GET', path = '/'] = key.split(' ');
  return {
    key,
    kind: 'http',
    method,
    path,
    op: 'action',
    surface: 'admin',
    module: 'platform',
    access: 'staff-permission',
    permission: null,
    ...extra,
  };
}

/** A contract with the fields these comparisons read. */
function contract(key: string, extra: Partial<ContractRow> = {}): ContractRow {
  const [method = 'GET', path = '/'] = key.split(' ');
  return { key, method, path, surface: 'admin', access: 'staff-permission', permission: null, ...extra };
}

describe('difference', () => {
  it('names the keys on one side only, both ways, sorted', () => {
    expect(difference('http', ['a', 'b'], ['b', 'c'])).toEqual([
      'http: a is built but not expected',
      'http: c is expected but not built',
    ]);
  });

  it('is empty for equal sets, whatever their order', () => {
    expect(difference('http', ['a', 'b'], new Set(['b', 'a']))).toEqual([]);
  });
});

describe('expectedKeys', () => {
  it('lists the keys of one kind that are not pending', () => {
    const manifest = [
      row('GET /a'),
      row('GET /b'),
      row('DHRU x', { kind: 'dhru-action' }),
      row('EVENT e', { kind: 'event' }),
    ];
    expect(expectedKeys(manifest, 'http', new Set(['GET /b']))).toEqual(['GET /a']);
    expect(expectedKeys(manifest, 'dhru-action', new Set())).toEqual(['DHRU x']);
  });
});

describe('rowMismatches and turnstileMismatches', () => {
  const manifest = [row('GET /admin/a', { turnstile: true }), row('POST /admin/b')];

  it('accepts a contract with the method, path and surface of its row, and skips one without a row', () => {
    expect(rowMismatches([contract('GET /admin/a'), contract('POST /api/index.php')], manifest)).toEqual([]);
  });

  it('flags another surface, method or path', () => {
    const wrong = rowMismatches(
      [contract('GET /admin/a', { surface: 'client' }), contract('POST /admin/b', { path: '/admin/c' })],
      manifest,
    );
    expect(wrong).toHaveLength(2);
    expect(wrong[0]).toContain('GET /admin/a');
    expect(wrong[1]).toContain('POST /admin/b');
  });

  it('flags a contract whose Turnstile flag differs from its row, either way', () => {
    expect(
      turnstileMismatches([contract('GET /admin/a', { turnstile: true }), contract('POST /admin/b')], manifest),
    ).toEqual([]);
    const wrong = turnstileMismatches(
      [contract('GET /admin/a'), contract('POST /admin/b', { turnstile: true })],
      manifest,
    );
    expect(wrong).toHaveLength(2);
  });
});

describe('accessMismatches', () => {
  const manifest = [
    row('PATCH /admin/x', { permission: 'wallet:adjust' }),
    row('GET /admin/none'),
    row('GET /admin/things', { op: 'list', permission: 'things:*' }),
    row('GET /admin/things/:id', { op: 'show', permission: 'things:*' }),
    row('POST /admin/things', { op: 'create', permission: 'things:*' }),
    row('PATCH /admin/things/:id', { op: 'update', permission: 'things:*' }),
    row('DELETE /admin/things/:id', { op: 'delete', permission: 'things:*' }),
    row('POST /admin/things/run', { op: 'action', permission: 'things:*' }),
    row('POST /admin/auth/2fa', { access: 'public' }),
  ];
  const check = (key: string, extra: Partial<ContractRow>, exceptions: Record<string, AccessException> = {}) =>
    accessMismatches([contract(key, extra)], manifest, exceptions);

  it('accepts the permission of the row and flags another one', () => {
    expect(check('PATCH /admin/x', { permission: 'wallet:adjust' })).toEqual([]);
    expect(check('PATCH /admin/x', { permission: 'wallet:read' })).toHaveLength(1);
    expect(check('PATCH /admin/x', { permission: 'staff:update' })).toHaveLength(1);
  });

  it('flags a permission on a row that has none, and none on a row that has one', () => {
    expect(check('GET /admin/none', {})).toEqual([]);
    expect(check('GET /admin/none', { permission: 'things:read' })).toHaveLength(1);
    expect(check('PATCH /admin/x', { permission: null })).toHaveLength(1);
  });

  it('turns area:* into the CRUD word of each operation', () => {
    expect(check('GET /admin/things', { permission: 'things:read' })).toEqual([]);
    expect(check('GET /admin/things/:id', { permission: 'things:read' })).toEqual([]);
    expect(check('POST /admin/things', { permission: 'things:create' })).toEqual([]);
    expect(check('PATCH /admin/things/:id', { permission: 'things:update' })).toEqual([]);
    expect(check('DELETE /admin/things/:id', { permission: 'things:delete' })).toEqual([]);
  });

  it('flags another word or another area on a CRUD endpoint', () => {
    expect(check('GET /admin/things', { permission: 'things:create' })).toHaveLength(1);
    expect(check('DELETE /admin/things/:id', { permission: 'things:update' })).toHaveLength(1);
    expect(check('GET /admin/things', { permission: 'staff:read' })).toHaveLength(1);
    expect(check('GET /admin/things', { permission: 'things:*' })).toHaveLength(1);
  });

  it('lets a single route under area:* use area:* or one action of the same area, not another area', () => {
    expect(check('POST /admin/things/run', { permission: 'things:*' })).toEqual([]);
    expect(check('POST /admin/things/run', { permission: 'things:generate' })).toEqual([]);
    expect(check('POST /admin/things/run', { permission: 'staff:update' })).toHaveLength(1);
    expect(check('POST /admin/things/run', { permission: null })).toHaveLength(1);
  });

  it('flags another access, unless the exception names the one the contract has', () => {
    expect(check('POST /admin/auth/2fa', { access: 'staff-session' })).toHaveLength(1);
    const exception: AccessException = { access: 'staff-session', mismatch: 'B1', reason: 'test' };
    expect(check('POST /admin/auth/2fa', { access: 'staff-session' }, { 'POST /admin/auth/2fa': exception })).toEqual(
      [],
    );
    expect(
      check('POST /admin/auth/2fa', { access: 'merchant-session' }, { 'POST /admin/auth/2fa': exception }),
    ).toHaveLength(1);
  });

  it('skips a contract without a row', () => {
    expect(check('POST /api/index.php', { permission: 'anything:goes' })).toEqual([]);
  });
});

describe('staleAccessExceptions', () => {
  const exception: AccessException = { access: 'staff-session', mismatch: 'B1', reason: 'test' };
  const manifest = [row('POST /admin/auth/2fa', { access: 'public' })];

  it('is empty while the contract still deviates as the exception says', () => {
    expect(
      staleAccessExceptions([contract('POST /admin/auth/2fa', { access: 'staff-session' })], manifest, {
        'POST /admin/auth/2fa': exception,
      }),
    ).toEqual([]);
  });

  it('names an exception whose contract now has the access of its row', () => {
    const stale = staleAccessExceptions([contract('POST /admin/auth/2fa', { access: 'public' })], manifest, {
      'POST /admin/auth/2fa': exception,
    });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toContain('POST /admin/auth/2fa');
  });

  it('names an exception whose contract is gone, or whose row is gone', () => {
    expect(staleAccessExceptions([], manifest, { 'POST /admin/auth/2fa': exception })).toHaveLength(1);
    expect(
      staleAccessExceptions([contract('POST /admin/auth/2fa', { access: 'staff-session' })], [], {
        'POST /admin/auth/2fa': exception,
      }),
    ).toHaveLength(1);
  });
});
