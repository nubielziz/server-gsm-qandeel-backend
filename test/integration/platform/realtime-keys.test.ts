// Integration test of the one audience key of an account (decision 037; decision 064): the viewer a stream opens with, the session
// doorbell that ends it and the inbox that feeds it all build `u:account:<id>`, for an account of either rank and through either door, so a
// doorbell for an account reaches that account's streams and no other stream, a staff member with the same number included. A listening
// test app on real Postgres and Redis.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  type Doorbell,
  RealtimeHub,
  RealtimePublisher,
  type RealtimeSource,
  type StreamViewer,
} from '@src/infra/realtime';
import { InboxRealtimeSource } from '@src/modules/platform';
import { makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertRole, insertStaff, openSession } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { eventually } from '../../support/infra';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { SAME_ORIGIN, type TestStream, clearStreamLimits, listen, openStream } from '../../support/stream';
import { RedisService } from '@src/infra/redis';

const prefix = testBullPrefix();
const clock = new TestClock();
let t: TestApp;
let base: string;
const open: TestStream[] = [];

async function stream(path: string, headers: Record<string, string>): Promise<TestStream> {
  const opened = await openStream(`${base}${path}`, headers);
  open.push(opened);
  expect(opened.status).toBe(200);
  expect((await opened.next()).event).toBe('ready');
  expect((await opened.next()).event).toBe('unread.changed');
  return opened;
}

/** The headers of a same-origin EventSource request of a new session of an account or a staff member. */
async function headersOf(subject: { type: 'staff' | 'account'; id: number }): Promise<Record<string, string>> {
  const session = await openSession(t, subject);
  return { ...SAME_ORIGIN, ...session.headers };
}

/** The viewer a stream of an account has (what `streamViewerOf` builds for either rank), and the hub's own audience keys for it. */
const viewerOf = (id: number): StreamViewer => ({
  kind: 'account',
  id,
  sessionId: 1,
  ip: '127.0.0.1',
  name: 'Test',
  permissions: [],
});
/** The hub's own key builder (a private method of the hub: the test reads what a viewer is listened to under). */
interface KeyBuilder {
  keysOf(viewer: StreamViewer, sources: readonly RealtimeSource[]): string[];
}
const hubKeysOf = (viewer: StreamViewer): string[] => t.app.get<KeyBuilder>(RealtimeHub).keysOf(viewer, []);

beforeAll(async () => {
  await testDb();
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix } });
  base = await listen(t);
  await eventually(() => (t.app.get(RealtimeHub).listening ? true : undefined));
});
afterAll(async () => {
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await resetDb();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearStreamLimits(t);
});
afterEach(async () => {
  for (const opened of open.splice(0)) opened.close();
  await eventually(() => (t.app.get(RealtimeHub).size === 0 ? true : undefined));
});

describe('the audience key of an account', () => {
  it('is one key for the viewer and the inbox: u:account:<id>, whatever the rank', async () => {
    const { db } = await testDb();
    const retail = await makeAccount({ db, rank: 'retail', password: null });
    const merchant = await makeAccount({ db, rank: 'merchant' });
    const source = t.app.get(InboxRealtimeSource);
    for (const account of [retail, merchant]) {
      // The viewer a stream has: the hub listens to this key for it (the inbox source adds none of its own).
      const keys = hubKeysOf(viewerOf(account.id));
      expect(keys).toEqual([`u:account:${account.id}`]);
      expect(source.keysFor()).toEqual([]);
      // The inbox asks the hub whether anyone listens to the key of the person an item is for: the very same key.
      const asked: string[] = [];
      const doorbell: Doorbell = {
        v: 1,
        topic: 'inbox',
        op: 'created',
        at: 0,
        type: 'account',
        ids: [account.id],
        itemId: 1,
      };
      await source.resolve(doorbell, (key) => {
        asked.push(key);
        return false;
      });
      expect(asked).toEqual(keys);
    }
    // A staff member keeps the staff key, and a kind of the old days is no key of anyone.
    expect(hubKeysOf({ ...viewerOf(7), kind: 'staff' })).toEqual(['u:staff:7']);
    const old: string[] = [];
    await source.resolve(
      { v: 1, topic: 'inbox', op: 'created', at: 0, type: 'customer', ids: [retail.id], itemId: 1 },
      (key) => (old.push(key), false),
    );
    await source.resolve(
      { v: 1, topic: 'inbox', op: 'created', at: 0, type: 'client', ids: [merchant.id], itemId: 1 },
      (key) => (old.push(key), false),
    );
    expect(old).toEqual([]);
  });

  it('is the key the session doorbell ends: a subject doorbell for an account ends its streams on either door and no other', async () => {
    const { db } = await testDb();
    const retail = await makeAccount({ db, rank: 'retail', password: null });
    const merchant = await makeAccount({ db, rank: 'merchant' });
    const staffId = await insertStaff(db, await insertRole(db, ['orders:read']));
    // The retail account and the staff member share the number 1: one key per kind keeps them apart.
    expect(staffId).toBe(retail.id);
    const shop = await stream('/store/v1/me/stream', await headersOf({ type: 'account', id: retail.id }));
    const portal = await stream('/client/stream', await headersOf({ type: 'account', id: merchant.id }));
    const adminStream = await stream('/admin/stream', await headersOf({ type: 'staff', id: staffId }));
    const publisher = t.app.get(RealtimePublisher);
    /** A recount after a doorbell: its frame comes after anything the doorbell wrote, so a stream that got no `bye` shows it first. */
    const barrier = () => publisher.publish('inbox', 'recount', { types: ['staff', 'account'] });

    // The words of the old days name no one: customer 1 and client 2 are not account 1 and 2.
    await publisher.publish('session', 'subject', { subjectType: 'customer', subjectId: retail.id });
    await publisher.publish('session', 'subject', { subjectType: 'client', subjectId: merchant.id });
    await barrier();
    for (const open of [shop, portal, adminStream]) expect((await open.next()).event).toBe('unread.changed');

    // A doorbell for the staff member ends the staff stream only: the account with the same number is not touched.
    await publisher.publish('session', 'subject', { subjectType: 'staff', subjectId: staffId });
    expect(await adminStream.next('bye')).toMatchObject({ data: { reason: 'reauth' } });
    await barrier();
    expect((await shop.next()).event).toBe('unread.changed');
    expect((await portal.next()).event).toBe('unread.changed');

    // A doorbell for an account ends its streams, through whichever door, and the other account's stream goes on.
    await publisher.publish('session', 'subject', { subjectType: 'account', subjectId: retail.id });
    expect(await shop.next('bye')).toMatchObject({ data: { reason: 'reauth' } });
    await barrier();
    expect((await portal.next()).event).toBe('unread.changed');
    await publisher.publish('session', 'subject', { subjectType: 'account', subjectId: merchant.id });
    expect(await portal.next('bye')).toMatchObject({ data: { reason: 'reauth' } });
  });
});
