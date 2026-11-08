// Helpers for the notification tests (feature 12a): the default templates (resetDb empties the table, the migration's rows are gone), the
// in-memory mail and Telegram drivers of a test app, and the token inside an emailed link.
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { DbService, type Database, schema as s } from '../../src/infra/db';
import {
  type DeliveryOutcome,
  DEFAULT_TEMPLATES,
  InMemoryMailDriver,
  InMemoryTelegramDriver,
  MAIL_DRIVER,
  NOTIFICATION_SEND_EVENT,
  type OutboxJobData,
  type OutboxPayload,
  OutboxService,
  TELEGRAM_DRIVER,
} from '../../src/modules/platform';
import type { PlanResult } from '../../src/modules/platform/notifications/event-notifier';
import {
  NotificationPlanProcessor,
  NotificationSendProcessor,
} from '../../src/modules/platform/notifications/notification.processors';
import type { TestApp } from './app';
import { openSession } from './auth';
import { PORTAL_ORIGIN } from './merchant-portal';

/**
 * Inserts the default templates the migration ships.
 *
 * @param db the test database
 */
export async function seedDefaultTemplates(db: Database): Promise<void> {
  await db
    .insert(s.notificationTemplates)
    .values(DEFAULT_TEMPLATES.map((template) => ({ ...template, isActive: true })))
    .onConflictDoNothing();
}

/**
 * The in-memory mail driver of a test app (under NODE_ENV=test nothing is ever sent by SMTP).
 *
 * @param t the running test app
 * @returns the driver: its `sent` list holds every mail
 */
export function mailbox(t: TestApp): InMemoryMailDriver {
  return t.app.get<InMemoryMailDriver>(MAIL_DRIVER);
}

/**
 * The in-memory Telegram driver of a test app that has a bot token.
 *
 * @param t the running test app (created with `TELEGRAM_BOT_TOKEN`)
 * @returns the driver: its `sent` list holds every message
 */
export function telegramOutbox(t: TestApp): InMemoryTelegramDriver {
  return t.app.get<InMemoryTelegramDriver>(TELEGRAM_DRIVER);
}

/**
 * Reads the token out of a link in a mail.
 *
 * @param text the text of a mail
 * @returns the decoded value of the `token` parameter of the first link that has one
 * @throws {Error} when the text has no such link
 */
export function tokenIn(text: string): string {
  const match = /[?&]token=([^\s&"<>)]+)/.exec(text);
  if (!match?.[1]) throw new Error(`No token link in: ${text}`);
  return decodeURIComponent(match[1]);
}

/** One answer of the portal: the parsed JSON next to the raw response. */
export interface PortalAnswer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON: the default keeps assertions short
  readonly body: any;
  readonly status: number;
  readonly res: LightMyRequestResponse;
}

/** A signed-in merchant's calls to the portal routes (the shared `portalFor` has no PUT, which the preferences need). */
export interface MerchantSession {
  readonly clientId: number;
  call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<PortalAnswer>;
  /** Sends a mutation with the cookie but no CSRF token. */
  withoutCsrf(method: 'POST' | 'PUT', url: string, payload?: unknown): Promise<PortalAnswer>;
}

/**
 * Opens a merchant session and returns a client for the portal routes, PUT included.
 *
 * @param t the running test app
 * @param clientId the merchant
 * @param ip the address the requests come from
 * @returns the client
 */
export async function merchantSession(t: TestApp, clientId: number, ip = '127.0.0.1'): Promise<MerchantSession> {
  const session = await openSession(t, { type: 'client', id: clientId });
  const send = async (
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    headers: Record<string, string>,
    payload?: unknown,
  ): Promise<PortalAnswer> => {
    const res = await t.app.inject({
      method,
      url,
      headers: { ...headers, origin: PORTAL_ORIGIN },
      remoteAddress: ip,
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
    return { body: res.body === '' ? undefined : JSON.parse(res.body), status: res.statusCode, res };
  };
  return {
    clientId,
    call: (method, url, payload) =>
      send(method, url, method === 'GET' ? session.headers : session.mutationHeaders, payload),
    withoutCsrf: (method, url, payload) => send(method, url, session.headers, payload),
  };
}

/**
 * Writes an outbox event the way a feature does (in its own transaction) and returns the job the relay would add for it.
 *
 * @param t the running test app
 * @param type the event type (it needs a route in the registry)
 * @param aggregateType the aggregate's table name
 * @param aggregateId the aggregate's id
 * @param payload the ids the event carries
 * @returns the job data of the event
 */
export async function emitEvent(
  t: TestApp,
  type: string,
  aggregateType: string,
  aggregateId: number,
  payload: OutboxPayload,
): Promise<OutboxJobData> {
  const row = await t.app
    .get(DbService)
    .db.transaction((tx) => t.app.get(OutboxService).add(tx, { type, aggregateType, aggregateId, payload }));
  return { eventId: row.id, type, aggregateType, aggregateId, payload, requestId: `test-${row.id}` };
}

let handMade = 900_000;

/**
 * Builds the job data of an event without writing an outbox row.
 *
 * Why: the planning job needs only the job data, so a test can plan an event whose route another feature registers (`invoice.paid`,
 * `deposit.approved`: feature 8 owns the producers, the lead adds their `notifications` routes when 8 is merged).
 *
 * @param type the event type
 * @param aggregateType the aggregate's table name
 * @param aggregateId the aggregate's id
 * @param payload the ids the event carries
 * @returns the job data, with an event id no real row has
 */
export function eventJob(
  type: string,
  aggregateType: string,
  aggregateId: number,
  payload: OutboxPayload,
): OutboxJobData {
  handMade += 1;
  return { eventId: handMade, type, aggregateType, aggregateId, payload, requestId: `test-${handMade}` };
}

/** What a send job looks like to its processor: the data, the attempt and the queue's maximum. */
const jobLike = <T>(data: T, attemptsMade: number) => ({ data, attemptsMade, opts: { attempts: 5 } }) as never;

/**
 * Runs the planning job of an outbox event, as the worker would.
 *
 * @param t the running test app
 * @param job the event's job data
 * @param attemptsMade how many attempts the queue made before this one
 * @returns what the planning job answered
 */
export function planEvent(t: TestApp, job: OutboxJobData, attemptsMade = 0): Promise<PlanResult> {
  return t.app.get(NotificationPlanProcessor).process(jobLike(job, attemptsMade));
}

/**
 * Runs the send job of one notification row, as the worker would.
 *
 * @param t the running test app
 * @param notificationId the row
 * @param attemptsMade how many attempts the queue made before this one
 * @returns what the attempt did; a transient failure rejects
 */
export function sendNotification(t: TestApp, notificationId: number, attemptsMade = 0): Promise<DeliveryOutcome> {
  return t.app.get(NotificationSendProcessor).process(jobLike({ notificationId }, attemptsMade));
}

/**
 * Sends every notification that has an outbox event, in order (a repeat of a finished one is skipped, as for a real job run twice).
 *
 * @param t the running test app
 * @returns the outcome of each row's job, in order of the events
 */
export async function sendAllQueued(t: TestApp): Promise<DeliveryOutcome[]> {
  const events = await t.app
    .get(DbService)
    .db.select()
    .from(s.outboxEvents)
    .where(eq(s.outboxEvents.type, NOTIFICATION_SEND_EVENT))
    .orderBy(s.outboxEvents.id);
  const outcomes: DeliveryOutcome[] = [];
  for (const event of events) outcomes.push(await sendNotification(t, event.aggregateId));
  return outcomes;
}

/**
 * Reads the notification rows, oldest first.
 *
 * @param db the test database
 * @returns every row of `notifications`
 */
export function notificationRows(db: Database) {
  return db.select().from(s.notifications).orderBy(s.notifications.id);
}
