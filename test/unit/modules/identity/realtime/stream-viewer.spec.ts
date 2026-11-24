// Unit tests of the viewer of a live stream (decision 037, decision 064): an account of either rank is one viewer kind, `account`, so the
// merchant route and the store route build the same key space; staff keep their own kind and their permissions.
import { describe, expect, it } from 'bun:test';
import { AppError } from '@src/common/errors';
import { streamCapsOf, streamViewerOf } from '@src/modules/identity/realtime/stream-viewer';
import type { Principal } from '@src/modules/identity/security/principal';

/** A principal of the given kind with the fields `streamViewerOf` reads; the rest of a real principal is not needed here. */
function principal(fields: Record<string, unknown>): Principal {
  return {
    ip: '203.0.113.7',
    session: { id: 55, subject: { name: 'Test Person' } },
    ...fields,
  } as unknown as Principal;
}

describe('streamViewerOf', () => {
  it('names an account of the merchant rank and one of the retail rank the same kind, by the account id', () => {
    const merchant = streamViewerOf(
      principal({ kind: 'account', accountId: 12, clientId: 12, rank: { id: 1, kind: 'merchant' } }),
    );
    const retail = streamViewerOf(
      principal({ kind: 'account', accountId: 114, clientId: 114, rank: { id: 4, kind: 'retail' } }),
    );
    expect(merchant).toEqual({
      ip: '203.0.113.7',
      kind: 'account',
      id: 12,
      sessionId: 55,
      name: 'Test Person',
      permissions: [],
    });
    expect(retail).toMatchObject({ kind: 'account', id: 114, permissions: [] });
  });

  it('keeps the staff kind with its permissions', () => {
    const viewer = streamViewerOf(principal({ kind: 'staff', staffId: 3, permissions: ['support:read'] }));
    expect(viewer).toMatchObject({ kind: 'staff', id: 3, sessionId: 55, permissions: ['support:read'] });
  });

  it('uses an empty name when the session holds none', () => {
    const viewer = streamViewerOf(principal({ kind: 'account', accountId: 9, session: { id: 56, subject: {} } }));
    expect(viewer.name).toBe('');
  });

  it('refuses a missing principal and every principal that is not a session', () => {
    expect(() => streamViewerOf(undefined)).toThrow(AppError);
    for (const kind of ['api-key', 'capability', 'webhook']) {
      expect(() => streamViewerOf(principal({ kind })), kind).toThrow(AppError);
    }
  });
});

describe('streamCapsOf', () => {
  it('caps by session first and by address second', () => {
    const viewer = streamViewerOf(principal({ kind: 'account', accountId: 12 }));
    expect(streamCapsOf(viewer, { maxPerSession: 3, maxPerIp: 30 })).toEqual([
      { key: 'session:55', max: 3 },
      { key: 'ip:203.0.113.7', max: 30 },
    ]);
  });
});
