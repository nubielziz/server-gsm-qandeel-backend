// Helpers for the support tests (feature 17): the default templates of the support events, customers, merchants, tickets and messages
// inserted straight into the test database, and a staff console with the support permissions.
import { eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { DbService, schema as s, type Database } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import {
  SUPPORT_DEFAULT_TEMPLATES,
  TICKET_MAIL_EVENT,
  TicketMailProcessor,
  type TicketMailJobResult,
} from '../../src/modules/support';
import { type AdminApi, adminWith } from './admin-api';
import type { TestApp } from './app';
import { insertMerchant } from './auth';
import { seedDefaultTemplates } from './notifications';

/**
 * Inserts the default templates of the platform and of the support events (`resetDb` empties the table, so the migrations' rows are gone).
 *
 * @param db the test database
 */
export async function seedSupportTemplates(db: Database): Promise<void> {
  await seedDefaultTemplates(db);
  await db
    .insert(s.notificationTemplates)
    .values(SUPPORT_DEFAULT_TEMPLATES.map((template) => ({ ...template, isActive: true })))
    .onConflictDoNothing();
}

let customers = 0;

/**
 * Inserts a customer with a unique email.
 *
 * @param db the test database
 * @param values columns to override
 * @returns the stored customer
 */
export async function insertCustomer(db: Database, values: Partial<typeof s.customers.$inferInsert> = {}) {
  customers += 1;
  const [row] = await db
    .insert(s.customers)
    .values({
      email: `customer-${customers}-${crypto.randomUUID().slice(0, 6)}@mail.example`,
      name: 'Sam Buyer',
      ...values,
    })
    .returning();
  return row!;
}

/**
 * Inserts a merchant (with its default group) and returns the stored row.
 *
 * @param db the test database
 * @param values columns to override
 * @returns the merchant
 */
export async function insertClient(db: Database, values: Partial<typeof s.clients.$inferInsert> = {}) {
  const id = await insertMerchant(db, values);
  const [row] = await db.select().from(s.clients).where(eq(s.clients.id, id));
  return row!;
}

let tickets = 0;

/**
 * Inserts a ticket straight into the table (a `new` ticket of a customer by default).
 *
 * @param db the test database
 * @param values columns to override; `requesterId` is required
 * @returns the stored ticket
 */
export async function insertSupportTicket(
  db: Database,
  values: Partial<typeof s.supportTickets.$inferInsert> & Pick<typeof s.supportTickets.$inferInsert, 'requesterId'>,
) {
  tickets += 1;
  const [row] = await db
    .insert(s.supportTickets)
    .values({
      number: `T-${9000 + tickets}`,
      subject: `Ticket ${tickets}`,
      requesterType: 'customer',
      token: `tok-${crypto.randomUUID().replace(/-/g, '')}`,
      ...values,
    })
    .returning();
  return row!;
}

/**
 * Inserts a message into a ticket's thread.
 *
 * @param db the test database
 * @param ticketId the ticket
 * @param values columns to override
 * @returns the stored message
 */
export async function insertSupportMessage(
  db: Database,
  ticketId: number,
  values: Partial<typeof s.ticketMessages.$inferInsert> = {},
) {
  const [row] = await db
    .insert(s.ticketMessages)
    .values({ ticketId, authorType: 'system', body: 'A message.', ...values })
    .returning();
  return row!;
}

/**
 * A signed-in staff member with the permissions of the Support role.
 *
 * @param t the running test app
 * @param permissions the role's permissions (default every support permission)
 * @param name the member's name
 * @returns the client for the admin routes
 */
export function supportStaff(t: TestApp, permissions: string[] = ['support:*'], name = 'Lina S.'): Promise<AdminApi> {
  return adminWith(t, permissions, { name });
}

/**
 * The outbox events of the ticket messages (receipt, reply, survey) written so far, oldest first.
 *
 * @param db the test database
 * @returns the `support.ticket_mail` rows
 */
export function ticketMailEvents(db: Database) {
  return db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, TICKET_MAIL_EVENT)).orderBy(s.outboxEvents.id);
}

/**
 * Deletes the counters of the `ticket-email` limiter (3 new tickets per email address per hour).
 *
 * Why: the counters live an hour in the cache Redis, which outlives a test and a test run, and the tests open many tickets from the same
 * few addresses.
 *
 * @param t the running test app
 */
export async function clearTicketEmailLimits(t: TestApp): Promise<void> {
  const redis = t.app.get(RedisService).cache;
  const found = await redis.keys(`${t.app.get(CacheKeys).rateLimit('ticket-email')}:*`);
  if (found.length > 0) await redis.del(...found);
}

/**
 * Runs the ticket mail job of every event written so far, in order, as the worker would (a repeat of a finished one is skipped, as for a
 * real job run twice).
 *
 * @param t the running test app
 * @param attemptsMade how many attempts the queue made before this one
 * @returns what each job answered
 */
export async function sendTicketMails(t: TestApp, attemptsMade = 0): Promise<TicketMailJobResult[]> {
  const events = await ticketMailEvents(t.app.get(DbService).db);
  const results: TicketMailJobResult[] = [];
  for (const event of events) {
    results.push(
      await t.app.get(TicketMailProcessor).process({
        data: {
          eventId: event.id,
          type: event.type,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          payload: event.payload,
          requestId: `test-${event.id}`,
        },
        attemptsMade,
        opts: { attempts: 5 },
      } as never),
    );
  }
  return results;
}
