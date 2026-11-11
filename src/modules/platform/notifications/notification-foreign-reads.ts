// Read-only lookups into tables other modules own, kept in this one file: who a notification goes to (a merchant, a staff member
// or a customer) and the fields of the order that an order notification talks about.
//
// DEVIATION to resolve when identity and customers export a reader: decision 016 wants these reads through the owning module's public
// service. The platform module is the base layer every module imports and imports no other module (decision 032: an import from
// here back into identity would form a cycle that breaks at class-definition time), so this file reads `clients`, `staff_users` and
// `customers` with plain selects, like the webhook foreign reads. Writes to these tables (a merchant's preferences and chat) are
// identity's and go through its use cases. Replace the bodies with calls to those services; nothing outside this file knows.
import { eq, inArray } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import type { NotificationAudience, NotificationRecipientType } from '../db/schema';
import { orderForEvent } from '../webhooks/webhook-foreign-reads';

/** Who a notification is for, as the delivery needs to know them. */
export interface Recipient {
  readonly type: NotificationRecipientType;
  readonly id: number;
  /** The template audience of this kind of recipient (`client` is `merchant`, identity-platform-11). */
  readonly audience: NotificationAudience;
  readonly name: string;
  readonly email: string;
  /** The language of their messages; merchants and staff have none and read English. */
  readonly locale: string;
  /** A merchant's linked Telegram chat; always `null` for staff and customers. */
  readonly telegramChatId: string | null;
  /** A merchant's `notification_prefs`; empty for the others. */
  readonly prefs: Readonly<Record<string, unknown>>;
  /** True for a suspended merchant or staff member, or a suspended or blocked customer: only transactional messages reach them. */
  readonly suspended: boolean;
  /**
   * True when the person has an inbox worth writing to: an active staff member, an active or pending merchant, an active customer
   * with an account (feature 23, plan 9.5). A guest customer has no account to read an inbox in.
   */
  readonly inboxEligible: boolean;
}

/**
 * Gives the audience a recipient type is written for.
 *
 * Why: identity-platform-11: `client` is `merchant`, the others map one to one.
 *
 * @param type `client`, `staff` or `customer`
 * @returns `merchant`, `staff` or `customer`
 */
export function audienceOf(type: NotificationRecipientType): NotificationAudience {
  return type === 'client' ? 'merchant' : type;
}

/**
 * Reads a recipient.
 *
 * @param db the database or a transaction
 * @param type `client` (a merchant), `staff` or `customer`
 * @param id the id in that table
 * @returns the recipient, or `undefined` when the row is gone
 */
export async function recipientOf(
  db: DbExecutor,
  type: NotificationRecipientType,
  id: number,
): Promise<Recipient | undefined> {
  switch (type) {
    case 'client': {
      const [row] = await db
        .select({
          name: s.clients.name,
          email: s.clients.email,
          status: s.clients.status,
          telegramChatId: s.clients.telegramChatId,
          prefs: s.clients.notificationPrefs,
          locale: s.clients.locale,
        })
        .from(s.clients)
        .where(eq(s.clients.id, id))
        .limit(1);
      return (
        row && {
          type,
          id,
          audience: 'merchant',
          name: row.name,
          email: row.email,
          // The merchant's own language (feature 20); `findTemplateFor` falls back to English when it has no template in it.
          locale: row.locale,
          telegramChatId: row.telegramChatId,
          prefs: row.prefs,
          suspended: row.status === 'suspended',
          inboxEligible: row.status !== 'suspended',
        }
      );
    }
    case 'staff': {
      const [row] = await db
        .select({ name: s.staffUsers.name, email: s.staffUsers.email, status: s.staffUsers.status })
        .from(s.staffUsers)
        .where(eq(s.staffUsers.id, id))
        .limit(1);
      return (
        row && {
          type,
          id,
          audience: 'staff',
          name: row.name,
          email: row.email,
          locale: 'en',
          telegramChatId: null,
          prefs: {},
          suspended: row.status === 'suspended',
          inboxEligible: row.status === 'active',
        }
      );
    }
    case 'customer': {
      const [row] = await db
        .select({
          name: s.customers.name,
          email: s.customers.email,
          locale: s.customers.locale,
          status: s.customers.status,
          hasAccount: s.customers.hasAccount,
        })
        .from(s.customers)
        .where(eq(s.customers.id, id))
        .limit(1);
      // An anonymized customer's address is a placeholder: nothing of any kind is sent (feature 23, plan 9.5).
      if (!row || row.status === 'anonymized') return undefined;
      return {
        type,
        id,
        audience: 'customer',
        name: row.name,
        email: row.email,
        locale: row.locale,
        telegramChatId: null,
        prefs: {},
        // Suspended and blocked customers get transactional messages only; the customer events that report on their own purchase
        // or ticket are registered transactional (S6).
        suspended: row.status !== 'active',
        inboxEligible: row.hasAccount && row.status === 'active',
      };
    }
  }
}

/**
 * Reads the names of staff members, for the "created by" of campaigns (feature 23).
 *
 * Why: the campaign list names its authors; one batched read for a page instead of one per row (no N+1).
 *
 * @param db the database or a transaction
 * @param ids staff ids (repeats are fine)
 * @returns id to name; a missing id is absent
 */
export async function staffNames(db: DbExecutor, ids: readonly number[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: s.staffUsers.id, name: s.staffUsers.name })
    .from(s.staffUsers)
    .where(inArray(s.staffUsers.id, unique));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** What an order notification talks about. */
export interface OrderFacts {
  readonly orderId: number;
  readonly clientId: number;
  readonly serviceName: string;
  readonly resultCode: string;
  readonly resultComment: string;
}

/**
 * Reads the public facts of a merchant's order.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @returns the facts, or `undefined` when the order is gone or belongs to a storefront customer
 */
export async function orderFacts(db: DbExecutor, orderId: number): Promise<OrderFacts | undefined> {
  const order = await orderForEvent(db, orderId);
  if (!order) return undefined;
  return {
    orderId: order.orderId,
    clientId: order.clientId,
    serviceName: order.serviceName,
    resultCode: order.resultCode ?? '',
    resultComment: order.resultComment ?? '',
  };
}
