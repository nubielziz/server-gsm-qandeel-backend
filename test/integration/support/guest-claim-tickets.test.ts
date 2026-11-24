// Integration tests of the support participant of the guest-order claim (decision 064): the tickets of a guest row and the messages the
// guest row wrote on them move to the account that proved the mailbox, with their link tokens, proof times and activity times untouched;
// the tickets and messages of everyone else stay, and a ticket another transaction holds makes the move refuse at once with the lock error
// (SQLSTATE 55P03) instead of waiting. Real Postgres; no application is needed (the participant is built by hand).
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { type Database, pgErrorInfo, schema as s } from '@src/infra/db';
import { GuestClaimParticipants } from '@src/modules/identity';
import {
  GUEST_CLAIM_SUPPORT,
  SupportGuestClaimParticipant,
} from '@src/modules/support/application/guest-claim.participant';
import { lockTicket } from '@src/modules/support/infra/ticket.repository';
import { makeAccount } from '../../support/accounts';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertSupportMessage, insertSupportTicket } from '../../support/support';

let db: Database;
const participant = new SupportGuestClaimParticipant(new GuestClaimParticipants());
const move = (guestId: number, accountId: number) =>
  db.transaction((tx) => participant.move(tx, { guestId, accountId }));

beforeEach(async () => {
  db = (await testDb()).db;
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

const requestersOf = async (): Promise<Array<[number, number]>> =>
  (await db.select().from(s.supportTickets).orderBy(asc(s.supportTickets.id))).map((row) => [row.id, row.requesterId]);

describe('SupportGuestClaimParticipant', () => {
  it('registers with the claim under the name support', () => {
    const registry = new GuestClaimParticipants();
    new SupportGuestClaimParticipant(registry).onModuleInit();
    expect(GUEST_CLAIM_SUPPORT).toBe('support');
    expect(registry.names()).toEqual(['support']);
  });

  it('moves the guest row’s tickets and its own messages to the account, and leaves everyone else’s alone', async () => {
    const guest = await makeAccount({ rank: 'retail', guest: true });
    const account = await makeAccount({ rank: 'retail' });
    const other = await makeAccount({ rank: 'retail' });
    const unproven = await insertSupportTicket(db, {
      requesterId: guest.id,
      requesterProvenAt: null,
      token: 'G7kq2Zp9Xw4Ld1Hn6Rb3Pp',
      updatedAt: new Date('2026-11-01T10:00:00.000Z'),
    });
    const proven = await insertSupportTicket(db, { requesterId: guest.id, token: 'H7kq2Zp9Xw4Ld1Hn6Rb3Pp' });
    const accountsOwn = await insertSupportTicket(db, { requesterId: account.id });
    const others = await insertSupportTicket(db, { requesterId: other.id });
    const mine = await insertSupportMessage(db, unproven.id, {
      authorType: 'account',
      authorId: guest.id,
      body: 'Typed by the guest.',
    });
    const reply = await insertSupportMessage(db, unproven.id, {
      authorType: 'staff',
      authorId: 1,
      body: 'Staff reply.',
    });
    const note = await insertSupportMessage(db, proven.id, {
      authorType: 'system',
      body: 'System note.',
      isInternal: true,
    });
    const theirs = await insertSupportMessage(db, others.id, { authorType: 'account', authorId: other.id });

    const moved = await move(guest.id, account.id);

    // Two tickets and the one message the guest row wrote.
    expect(moved).toBe(3);
    expect(await requestersOf()).toEqual([
      [unproven.id, account.id],
      [proven.id, account.id],
      [accountsOwn.id, account.id],
      [others.id, other.id],
    ]);
    const authors = (await db.select().from(s.ticketMessages).orderBy(asc(s.ticketMessages.id))).map((row) => [
      row.id,
      row.authorType,
      row.authorId,
    ]);
    expect(authors).toEqual([
      [mine.id, 'account', account.id],
      [reply.id, 'staff', 1],
      [note.id, 'system', null],
      [theirs.id, 'account', other.id],
    ]);
    // Only pointers changed: the link token, the proof of the address and the activity time stay (a claim is not activity).
    const [after] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, unproven.id));
    expect(after).toMatchObject({ token: 'G7kq2Zp9Xw4Ld1Hn6Rb3Pp', requesterProvenAt: null });
    expect(after!.updatedAt.toISOString()).toBe('2026-11-01T10:00:00.000Z');
    // The guest row has nothing left: a second call moves nothing.
    expect(await move(guest.id, account.id)).toBe(0);
  });

  it('moves nothing for a guest row without tickets', async () => {
    const guest = await makeAccount({ rank: 'retail', guest: true });
    const account = await makeAccount({ rank: 'retail' });
    expect(await move(guest.id, account.id)).toBe(0);
  });

  it('refuses at once with the lock error while another transaction holds one of the tickets, and moves nothing', async () => {
    const guest = await makeAccount({ rank: 'retail', guest: true });
    const account = await makeAccount({ rank: 'retail' });
    const held = await insertSupportTicket(db, { requesterId: guest.id });
    await insertSupportTicket(db, { requesterId: guest.id });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    // A staff reply or a status change that holds the ticket at the same time.
    const holder = db.transaction(async (tx) => {
      await lockTicket(tx, held.id);
      locked();
      await hold;
    });
    await holding;
    const started = performance.now();
    const failure = await move(guest.id, account.id).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(pgErrorInfo(failure)?.code).toBe('55P03');
    expect(performance.now() - started).toBeLessThan(2_000);
    release();
    await holder;
    // The refused claim rolled back: both tickets still belong to the guest row.
    expect((await requestersOf()).every(([, owner]) => owner === guest.id)).toBe(true);
  });
});
