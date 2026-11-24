// The content of an account data export (feature 18, GET /admin/clients/:id/export, the data-subject access right): what is in the file
// and what is never in it. Pure, no database.
import type { RankKind } from '../../identity';
import type { WalletExport } from '../../money';
import type { AccountRow } from '../infra/customer.repository';
import type { ExportRows, MerchantExport } from '../infra/privacy-reads.repository';

/** The format version of the file, so a reader can tell when the shape changes. */
export const EXPORT_FORMAT = 4;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** The rank an export names: the stored row of the rank and its kind in the words of the wire. */
export interface ExportRankOf {
  readonly id: number;
  readonly name: string;
  readonly kind: RankKind;
}

/** What {@link buildAccountExport} needs. */
export interface AccountExportInput {
  /** The account row. */
  readonly account: AccountRow;
  /** The account's rank. */
  readonly rank: ExportRankOf;
  /** The rows read about the account. */
  readonly rows: ExportRows;
  /** The guest row of the account's proven email, with the rows read about it; left out when there is none. */
  readonly guest?: { readonly email: string; readonly rows: ExportRows } | undefined;
  /**
   * The merchant parts (wallet and statement, API keys, invoices): for a merchant rank, and for an account that held one (its merchant wallet
   * has entries, or it has an API key or a merchant invoice; `holdsMerchantPart`).
   */
  readonly merchant?: MerchantExport | undefined;
  /** The store balance and its lines (money's `CustomerWallets.exportOf`): for a retail rank, and for any account whose store wallet has entries. */
  readonly wallet?: WalletExport | undefined;
  /** The clock's time. */
  readonly exportedAt: Date;
  /** Decrypts the stored IMEI of a checkout session (`null` stays `null`; an unreadable text becomes `null`). */
  readonly imeiOf: (ciphertext: string | null) => string | null;
}

/**
 * Builds the export document of one account.
 *
 * Why: the console downloads it as `account-<id>.json` (B49, RESOLUTIONS b2c-8, decision 064: every rank can be exported). It holds the
 * profile (with the rank, and the company, address, tax id and username when the account has them), the orders (service, IMEI, status,
 * totals, dates), the payments without card data (no brand, fingerprint or gateway payload), the consents, the checkout sessions, the
 * support tickets with their public messages (never the internal notes), the data requests and the uploaded files (name and size, never
 * where they are stored). A merchant rank adds its wallet and statement, its API keys (label and dates: never a key and never a hash) and
 * its invoices. Passwords, sessions and tokens are not personal data the account can use and are never included. What staff keep to
 * protect the shop is left out too: the internal notes, the reason of a suspension and the blocklist entries made from the account's
 * data. The file has what the account gave and did, not what the shop thinks of it. An IMEI is decrypted for the file, and an erased one
 * is `null`. The store balance and its statement (`wallet`, staff reasons hidden) come with a retail account. Every wallet with entries is
 * in the file whatever the rank is today: an account that was retail and is a merchant now keeps its store balance history, and the other
 * way round (each wallet in its own section).
 *
 * For a retail account whose email was proven, the orders, checkouts, consents, tickets and files of the guest row of
 * that email are the same person's, so they are listed apart, under `ordersPlacedAsGuest`.
 *
 * Format history: 2 (decision 039): `profile.locale` is gone. 3: `imeiChecks` is gone, because the log it listed is retired. 4 (decision
 * 064): one account type: `profile.rank`, the merchant parts and the guest section are added, `files` is added, and `firstOrderAt` and
 * `totalSpent` are gone (nothing ever wrote them).
 *
 * @param input the account, its rank, the rows read and the optional parts
 * @returns a JSON-serialisable object
 */
export function buildAccountExport(input: AccountExportInput): Record<string, unknown> {
  const { account, rank, rows, guest, merchant, wallet, exportedAt, imeiOf } = input;
  return {
    format: EXPORT_FORMAT,
    exportedAt: exportedAt.toISOString(),
    profile: {
      id: account.id,
      email: account.email,
      emailVerifiedAt: iso(account.emailVerifiedAt),
      name: account.name,
      phone: account.phone,
      country: account.country,
      currency: account.currency,
      hasAccount: account.hasAccount,
      marketingOptIn: account.marketingOptIn,
      status: account.status,
      rank: { id: rank.id, name: rank.name, kind: rank.kind },
      ...(account.username === null ? {} : { username: account.username }),
      ...(account.company === '' ? {} : { company: account.company }),
      ...(account.address === '' ? {} : { address: account.address }),
      ...(account.taxId === '' ? {} : { taxId: account.taxId }),
      lastLoginAt: iso(account.lastLoginAt),
      anonymizedAt: iso(account.anonymizedAt),
      createdAt: account.createdAt.toISOString(),
    },
    ...sectionsOf(rows, imeiOf),
    ...(wallet ? { wallet } : {}),
    ...(merchant ? { merchant: merchantSection(merchant) } : {}),
    ...(guest
      ? {
          ordersPlacedAsGuest: {
            email: guest.email,
            ...guestSectionsOf(guest.rows, imeiOf),
          },
        }
      : {}),
  };
}

/** The sections every account has. */
function sectionsOf(rows: ExportRows, imeiOf: (ciphertext: string | null) => string | null) {
  return {
    orders: ordersOf(rows),
    payments: paymentsOf(rows),
    consents: consentsOf(rows),
    checkoutSessions: sessionsOf(rows, imeiOf),
    supportTickets: ticketsOf(rows),
    dataRequests: rows.requests.map((request) => ({
      id: request.id,
      kind: request.kind,
      status: request.status,
      requestedAt: request.requestedAt.toISOString(),
      dueAt: request.dueAt.toISOString(),
      completedAt: iso(request.completedAt),
    })),
    files: filesOf(rows),
  };
}

/** The section of the guest row: its orders, payments, checkouts, consents, tickets and files. */
function guestSectionsOf(rows: ExportRows, imeiOf: (ciphertext: string | null) => string | null) {
  return {
    orders: ordersOf(rows),
    payments: paymentsOf(rows),
    checkoutSessions: sessionsOf(rows, imeiOf),
    consents: consentsOf(rows),
    supportTickets: ticketsOf(rows),
    files: filesOf(rows),
  };
}

function ordersOf(rows: ExportRows) {
  return rows.orders.map((order) => ({
    id: order.id,
    service: order.service,
    imei: order.imei,
    status: order.status,
    quantity: order.quantity,
    totalPrice: order.totalPrice,
    taxAmount: order.taxAmount,
    currency: order.currency,
    createdAt: order.createdAt.toISOString(),
    completedAt: iso(order.completedAt),
  }));
}

function paymentsOf(rows: ExportRows) {
  return rows.payments.map((payment) => ({
    id: payment.id,
    orderId: payment.orderId,
    amount: payment.amount,
    feeAmount: payment.feeAmount,
    currency: payment.currency,
    status: payment.status,
    method: payment.methodType,
    capturedAt: iso(payment.capturedAt),
    createdAt: payment.createdAt.toISOString(),
  }));
}

function consentsOf(rows: ExportRows) {
  return rows.consents.map((consent) => ({
    id: consent.id,
    purpose: consent.purpose,
    granted: consent.granted,
    ip: consent.ip,
    userAgent: consent.userAgent,
    checkoutSessionId: consent.checkoutSessionId,
    orderId: consent.orderId,
    createdAt: consent.createdAt.toISOString(),
  }));
}

function sessionsOf(rows: ExportRows, imeiOf: (ciphertext: string | null) => string | null) {
  return rows.sessions.map((session) => ({
    id: session.id,
    email: session.email,
    service: session.service,
    imei: imeiOf(session.imeiEnc),
    quantity: session.quantity,
    currency: session.currency,
    netAmount: session.netAmount,
    taxAmount: session.taxAmount,
    grossAmount: session.grossAmount,
    taxCountry: session.taxCountry,
    status: session.status,
    ip: session.ip,
    ipCountry: session.ipCountry,
    userAgent: session.userAgent,
    orderId: session.orderId,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  }));
}

function ticketsOf(rows: ExportRows) {
  return rows.tickets.map((ticket) => ({
    number: ticket.number,
    subject: ticket.subject,
    status: ticket.status,
    category: ticket.category,
    createdAt: ticket.createdAt.toISOString(),
    messages: ticket.messages.map((message) => ({
      author: message.author,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    })),
  }));
}

function filesOf(rows: ExportRows) {
  return rows.files.map((file) => ({
    id: file.id,
    filename: file.filename,
    mime: file.mime,
    size: file.size,
    createdAt: file.createdAt.toISOString(),
  }));
}

/** The merchant part of the file: the wallet and its statement, the API keys (never a hash) and the invoices. */
function merchantSection(merchant: MerchantExport) {
  return {
    wallet:
      merchant.wallet === null
        ? null
        : {
            currency: merchant.wallet.currency,
            balance: merchant.wallet.balance,
            reserved: merchant.wallet.reserved,
            creditLimit: merchant.wallet.creditLimit,
            statement: merchant.wallet.lines.map((line) => ({
              at: line.at.toISOString(),
              kind: line.kind,
              amount: line.amount,
              balanceAfter: line.balanceAfter,
            })),
          },
    apiKeys: merchant.apiKeys.map((key) => ({
      id: key.id,
      label: key.name,
      prefix: key.prefix,
      createdAt: key.createdAt.toISOString(),
      lastUsedAt: iso(key.lastUsedAt),
      expiresAt: iso(key.expiresAt),
      revokedAt: iso(key.revokedAt),
    })),
    invoices: merchant.invoices.map((invoice) => ({
      number: invoice.number,
      kind: invoice.kind,
      status: invoice.status,
      amount: invoice.amount,
      total: invoice.total,
      currency: invoice.currency,
      createdAt: invoice.createdAt.toISOString(),
      paidAt: iso(invoice.paidAt),
    })),
  };
}
