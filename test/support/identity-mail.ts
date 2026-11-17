// Test helper for feature 20: the default templates of the identity events (merchant lifecycle and staff link mails).
import { eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { schema as s, type Database } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { MERCHANT_MAIL_EVENTS, STAFF_MAIL_EVENTS, identityTemplatesSql } from '../../src/modules/identity';
import {
  EmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  PasswordResetMailProcessor,
} from '../../src/modules/identity/jobs/merchant-mail.processors';
import {
  StaffInvitedMailProcessor,
  StaffPasswordResetMailProcessor,
} from '../../src/modules/identity/jobs/staff-mail.processors';
import type { OutboxJobData } from '../../src/modules/platform';
import type { TestApp } from './app';
import { testDb } from './db';
import { installTemplates, seedDefaultTemplates } from './notifications';

/**
 * Inserts the default templates of the platform and of the identity events (`resetDb` empties the table, so the migrations' rows are gone).
 *
 * @param db the test database
 */
export async function seedIdentityTemplates(db: Database): Promise<void> {
  await seedDefaultTemplates(db);
  await installTemplates(db, identityTemplatesSql());
}

/**
 * Deletes the counters of the `account-mail` limiter (the cache Redis outlives a test run, and merchant ids repeat after `resetDb`).
 *
 * @param t the running test app
 */
export async function clearAccountMailLimits(t: TestApp): Promise<void> {
  const redis = t.app.get(RedisService).cache;
  const found = await redis.keys(`${t.app.get(CacheKeys).rateLimit('account-mail')}:*`);
  if (found.length > 0) await redis.del(...found);
}

/**
 * Runs the mail job of the newest outbox event of a merchant mail type, as the worker would (it rotates the link token and sends the mail).
 *
 * @param t the running test app
 * @param type which merchant mail: `invited`, `password_reset` or `email_verification`
 */
export async function runMerchantMailJob(t: TestApp, type: keyof typeof MERCHANT_MAIL_EVENTS): Promise<void> {
  const { db } = await testDb();
  const rows = await db
    .select()
    .from(s.outboxEvents)
    .where(eq(s.outboxEvents.type, MERCHANT_MAIL_EVENTS[type]))
    .orderBy(s.outboxEvents.id);
  const event = rows.at(-1)!;
  const { meta: _meta, ...payload } = event.payload;
  const job = {
    data: {
      eventId: event.id,
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: payload as OutboxJobData['payload'],
      requestId: 'test',
    },
    attemptsMade: 0,
    opts: { attempts: 5 },
  } as never;
  const processor =
    type === 'invited'
      ? t.app.get(MerchantInvitedMailProcessor)
      : type === 'password_reset'
        ? t.app.get(PasswordResetMailProcessor)
        : t.app.get(EmailVerificationMailProcessor);
  await (processor as { process(job: never): Promise<unknown> }).process(job);
}

/**
 * The job data of the newest outbox event of a staff mail type (what the relay would hand the queue).
 *
 * @param type which staff mail: `invited` or `password_reset`
 * @param index which event, oldest first (default: the newest)
 * @returns the data of the job, or `undefined` when no such event exists
 */
export async function staffMailJobData(
  type: keyof typeof STAFF_MAIL_EVENTS,
  index = -1,
): Promise<OutboxJobData | undefined> {
  const { db } = await testDb();
  const rows = await db
    .select()
    .from(s.outboxEvents)
    .where(eq(s.outboxEvents.type, STAFF_MAIL_EVENTS[type]))
    .orderBy(s.outboxEvents.id);
  const event = rows.at(index);
  if (!event) return undefined;
  const { meta: _meta, ...payload } = event.payload;
  return {
    eventId: event.id,
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: payload as OutboxJobData['payload'],
    requestId: 'test',
  };
}

/**
 * Runs the mail job of a staff mail event, as the worker would (it rotates the link token and sends the mail).
 *
 * @param t the running test app
 * @param type which staff mail
 * @param data the job data (default: the newest event of that type)
 * @param attemptsMade how many attempts the queue made before this one
 * @returns what the job answered; a transient mail failure rejects
 */
export async function runStaffMailJob(
  t: TestApp,
  type: keyof typeof STAFF_MAIL_EVENTS,
  data?: OutboxJobData,
  attemptsMade = 0,
): Promise<unknown> {
  const job = { data: data ?? (await staffMailJobData(type)), attemptsMade, opts: { attempts: 5 } } as never;
  const processor =
    type === 'invited' ? t.app.get(StaffInvitedMailProcessor) : t.app.get(StaffPasswordResetMailProcessor);
  return (processor as { process(job: never): Promise<unknown> }).process(job);
}
