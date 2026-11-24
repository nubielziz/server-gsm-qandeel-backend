// Integration test of the data migration that retires the satisfaction survey of a ticket: the SQL is run on rows written before it (the stored
// template of the survey mail, unrelayed outbox events of the ticket mail job of every kind, a resolved ticket that holds a rating) and run again,
// as a database that already has it would. The columns "csat_score" and "survey_sent_at" stay in this step, so the test also proves the migration
// leaves the tickets, the other templates and the handled events alone.
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertCustomer, insertSupportTicket } from '../../support/support';

const FOLDER = join(import.meta.dir, '../../../drizzle');
// The file is found by its name, not its number: the number is given when the branches are merged.
const NAME = readdirSync(FOLDER).find((file) => file.endsWith('_retired_features.sql'));

beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

async function migrate(): Promise<void> {
  const { pool } = await testDb();
  await pool.query(readFileSync(join(FOLDER, NAME ?? 'missing'), 'utf8'));
}

async function insertTemplate(
  event: string,
  channel: 'email' | 'telegram',
  audience: 'customer' | 'merchant',
): Promise<void> {
  const { db } = await testDb();
  await db.insert(s.notificationTemplates).values({ event, channel, audience, subject: 'S', body: 'B' });
}

describe('the migration that retires the satisfaction survey of a ticket', () => {
  it('exists in the migrations folder', () => {
    expect(NAME).toBeDefined();
  });

  it('deletes the stored template of the survey mail and keeps every other template, and changes nothing when run again', async () => {
    const { db } = await testDb();
    await insertTemplate('support.csat_survey', 'email', 'customer');
    await insertTemplate('support.ticket_received', 'email', 'customer');
    await insertTemplate('support.reply', 'email', 'customer');
    await insertTemplate('support.reply', 'email', 'merchant');
    const events = async () =>
      (await db.select().from(s.notificationTemplates).orderBy(asc(s.notificationTemplates.id))).map(
        (row) => `${row.event}|${row.channel}|${row.audience}`,
      );

    await migrate();
    const once = await events();
    expect(once).toEqual([
      'support.ticket_received|email|customer',
      'support.reply|email|customer',
      'support.reply|email|merchant',
    ]);

    await migrate();
    expect(await events()).toEqual(once);
  });

  it('marks the unrelayed survey events as handled and leaves the receipts, the replies, the handled ones and every other outbox row as they are', async () => {
    const { db } = await testDb();
    const PROCESSED = new Date('2026-02-01T00:00:00.000Z');
    const ticketMail = (aggregateId: number, payload: Record<string, unknown>, processedAt?: Date) => ({
      type: 'support.ticket_mail',
      aggregateType: 'support_tickets',
      aggregateId,
      payload,
      ...(processedAt === undefined ? {} : { processedAt }),
    });
    await db
      .insert(s.outboxEvents)
      .values([
        ticketMail(1, { kind: 'survey' }),
        ticketMail(2, { kind: 'survey' }, PROCESSED),
        ticketMail(3, { kind: 'received' }),
        ticketMail(4, { kind: 'reply', messageId: 9, channel: 'email' }),
        { type: 'order.status_changed', aggregateType: 'orders', aggregateId: 7, payload: { kind: 'survey' } },
      ]);
    const rows = async () => await db.select().from(s.outboxEvents).orderBy(asc(s.outboxEvents.id));

    await migrate();
    const once = await rows();
    expect(once[0]!.processedAt).toBeInstanceOf(Date);
    expect(once[1]!.processedAt).toEqual(PROCESSED);
    expect(once[2]!.processedAt).toBeNull();
    expect(once[3]!.processedAt).toBeNull();
    // Another event type that happens to carry a payload key of that name is not a ticket mail.
    expect(once[4]!.processedAt).toBeNull();

    await migrate();
    expect(await rows()).toEqual(once);
  });

  it('runs on an empty database, and leaves a ticket that holds an old rating as it is', async () => {
    const { db } = await testDb();
    await migrate();
    const customer = await insertCustomer(db);
    const ticket = await insertSupportTicket(db, {
      requesterId: customer.id,
      status: 'resolved',
      resolvedAt: new Date('2026-11-01T10:00:00.000Z'),
      csatScore: 4,
      surveySentAt: new Date('2026-11-01T10:00:00.000Z'),
    });

    await migrate();
    const [after] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id));
    expect(after).toEqual(ticket);
    expect(after).toMatchObject({ csatScore: 4 });
  });
});
