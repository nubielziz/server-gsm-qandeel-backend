// Read-only lookups into tables other modules own, kept in this one file: who a notification goes to (a staff member or an account of
// either rank) and the fields of the order that an order notification talks about.
//
// DEVIATION to resolve when identity exports a reader that platform may import: decision 016 wants these reads through the owning module's public
// service. The platform module is the base layer every module imports and imports no module statically (decision 032: an import from
// here back into identity would form a cycle that breaks at class-definition time), so this file reads `clients`, `client_groups`,
// `staff_users`, `orders`, `invoices` and `services` with plain selects, and takes the three account rules (may it act, is it gone,
// is its rank a merchant rank) from the identity barrel at call time (`identityApi`, a late import). Writes to these tables (a
// merchant's preferences) are identity's and go through its use cases. Replace the bodies with calls to those services; nothing
// outside this file knows.
import { eq, inArray } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import type { NotificationAudience, NotificationRecipientType } from '../db/schema';
import { identityApi } from './identity-api';

/** The door an order came through, as the orders table stores it (read through the shared schema: platform imports no module). */
type OrderSource = (typeof s.orders.$inferSelect)['source'];
/** The wallet kind an invoice fills, as the invoices table stores it. */
type InvoiceWalletKind = NonNullable<(typeof s.invoices.$inferSelect)['walletKind']>;

/**
 * The old type words of the merchant and customer days.
 *
 * Why: decision 064: a stored recipient is `staff` or `account`. A queued row, a job or a link made before the accounts were merged may
 * still say `client` (an old merchant number, which is the account id) or `customer` (an old customer number, which is NOT an account
 * id). Only {@link recipientOf} reads them, and only through the legacy id map.
 */
export type LegacyRecipientType = 'client' | 'customer';

/** Who a notification is for, as the delivery needs to know them. */
export interface Recipient {
  /** `staff`, or `account` for a person of either rank (a guest row is an account row too). */
  readonly type: NotificationRecipientType;
  /** The staff member's id, or the account id (a legacy number is resolved first). */
  readonly id: number;
  /**
   * The template audience of this recipient: `staff`, or for an account `merchant` when its rank is a merchant rank and `customer`
   * for every other rank and for a guest (decision 064). A message may name another audience (the door of an order,
   * the kind of a wallet): see `NotificationInput.audience`.
   */
  readonly audience: NotificationAudience;
  readonly name: string;
  readonly email: string;
  /** An account's `notification_prefs` (only the merchant texts read them); empty for staff. */
  readonly prefs: Readonly<Record<string, unknown>>;
  /** True for a staff member who is suspended, or an account that may not act (suspended or blocked): only transactional messages reach them. */
  readonly suspended: boolean;
  /**
   * True when the person has an inbox worth writing to: an active staff member, an active account that can sign in (a guest row has no
   * account to read an inbox in).
   */
  readonly inboxEligible: boolean;
}

/**
 * Returns the recipient with another template audience.
 *
 * Why: the text of an order mail follows the door of the order, a wallet mail the kind of the wallet and a support reply the rank of
 * the asker (decision 064), never the rank the account holds today; the audience a row was made for is kept in its payload and
 * applied here when the row is sent.
 *
 * @param recipient the recipient read from its row
 * @param audience the audience the message was made for, or `undefined` to keep the rank's audience
 * @returns the same recipient with that audience (a staff recipient is never changed)
 */
export function withAudience(recipient: Recipient, audience: NotificationAudience | undefined): Recipient {
  return audience === undefined || recipient.type === 'staff' ? recipient : { ...recipient, audience };
}

/**
 * Reads a staff member as a recipient.
 *
 * @param db the database or a transaction
 * @param id the staff member
 * @returns the recipient, or `undefined` when the row is gone
 */
async function staffRecipientOf(db: DbExecutor, id: number): Promise<Recipient | undefined> {
  const [row] = await db
    .select({ name: s.staffUsers.name, email: s.staffUsers.email, status: s.staffUsers.status })
    .from(s.staffUsers)
    .where(eq(s.staffUsers.id, id))
    .limit(1);
  return (
    row && {
      type: 'staff',
      id,
      audience: 'staff',
      name: row.name,
      email: row.email,
      prefs: {},
      suspended: row.status === 'suspended',
      inboxEligible: row.status === 'active',
    }
  );
}

/**
 * Reads a recipient.
 *
 * @param db the database or a transaction
 * @param type `staff` or `account`; the old words `client` and `customer` are resolved through the legacy id map (a number that is
 *   not in it reads as a missing recipient, never as another person)
 * @param id the id in that table (for an old word, the old number)
 * @returns the recipient, or `undefined` when the row is gone, the account was erased (its address is a placeholder: nothing is sent)
 *   or an old number has no account
 */
export async function recipientOf(
  db: DbExecutor,
  type: NotificationRecipientType | LegacyRecipientType,
  id: number,
): Promise<Recipient | undefined> {
  if (type === 'staff') return staffRecipientOf(db, id);
  const { LegacyAccounts, canAct, rankKindOf, sessionStateOf } = await identityApi();
  const accountId = type === 'account' ? id : await new LegacyAccounts().resolve(db, type, id);
  if (accountId === undefined) return undefined;
  const [row] = await db
    .select({
      name: s.clients.name,
      email: s.clients.email,
      status: s.clients.status,
      prefs: s.clients.notificationPrefs,
      hasAccount: s.clients.hasAccount,
      groupKind: s.clientGroups.kind,
    })
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(eq(s.clients.id, accountId))
    .limit(1);
  // An erased account's address is a placeholder: nothing of any kind is sent (feature 23, plan 9.5).
  if (!row || sessionStateOf(row.status) === 'gone') return undefined;
  return {
    type: 'account',
    id: accountId,
    audience: rankKindOf(row.groupKind) === 'merchant' ? 'merchant' : 'customer',
    name: row.name,
    email: row.email,
    prefs: row.prefs,
    // Suspended and blocked accounts get transactional messages only; the events that report on their own purchase or ticket are
    // registered transactional (S6). One reading of the status for every rank.
    suspended: !canAct(row.status),
    inboxEligible: row.hasAccount && canAct(row.status),
  };
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
  /** The buyer account of the order (decision 064: every order has one, whatever its door). */
  readonly accountId: number;
  /** The door the order came through: it decides whose text applies (`store` is the shop's customer text, any other door the merchant text). */
  readonly source: OrderSource;
  readonly serviceName: string;
  readonly resultCode: string;
  readonly resultComment: string;
}

/**
 * Reads the public facts of an order.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @returns the facts, or `undefined` when the order is gone
 */
export async function orderFacts(db: DbExecutor, orderId: number): Promise<OrderFacts | undefined> {
  const [row] = await db
    .select({
      orderId: s.orders.id,
      accountId: s.orders.accountId,
      source: s.orders.source,
      serviceName: s.services.name,
      resultCode: s.orders.resultCode,
      resultComment: s.orders.resultComment,
    })
    .from(s.orders)
    .innerJoin(s.services, eq(s.services.id, s.orders.serviceId))
    .where(eq(s.orders.id, orderId))
    .limit(1);
  if (!row) return undefined;
  return {
    orderId: row.orderId,
    accountId: row.accountId,
    source: row.source,
    serviceName: row.serviceName,
    resultCode: row.resultCode ?? '',
    resultComment: row.resultComment ?? '',
  };
}

/** What an invoice notification talks about. */
export interface InvoiceFacts {
  readonly accountId: number;
  /** The wallet the invoice fills, fixed when it was made; `null` for a receipt or a statement (they are not wallet mails). */
  readonly walletKind: InvoiceWalletKind | null;
  readonly number: string;
  readonly amount: string;
  readonly currency: string;
}

/**
 * Reads the public facts of an invoice.
 *
 * @param db the database or a transaction
 * @param invoiceId the invoice
 * @returns the facts, or `undefined` when the invoice is gone
 */
export async function invoiceFacts(db: DbExecutor, invoiceId: number): Promise<InvoiceFacts | undefined> {
  const [row] = await db
    .select({
      accountId: s.invoices.accountId,
      walletKind: s.invoices.walletKind,
      number: s.invoices.number,
      amount: s.invoices.amount,
      currency: s.invoices.currency,
    })
    .from(s.invoices)
    .where(eq(s.invoices.id, invoiceId))
    .limit(1);
  return row;
}

/**
 * Reads the name of a service.
 *
 * @param db the database or a transaction
 * @param serviceId the service id
 * @returns the name, or `undefined` when there is no such service
 */
export async function serviceNameOf(db: DbExecutor, serviceId: number): Promise<string | undefined> {
  const [row] = await db
    .select({ name: s.services.name })
    .from(s.services)
    .where(eq(s.services.id, serviceId))
    .limit(1);
  return row?.name;
}
