// Builds what the customer routes send: the admin list row and detail, the store account and the store order row, from the
// stored rows. Pure functions (no I/O), so the shape rules are unit-tested.
import type { z } from 'zod';
import type { CustomerDetailSchema, CustomerSchema } from '../contracts/customers.contracts';
import type { StoreMeSchema, StoreOrderSchema } from '../contracts/store-account.contracts';
import type { Customer } from '../db/schema';
import { documentLabel } from '../domain/consent-documents';
import type { ConsentEvidence, DetailCounts, RiskSummary, StoreOrderRow } from '../infra/foreign-reads.repository';
import type { CustomerRow } from '../infra/customer.repository';

/** A customer on the wire. */
export type WireCustomer = z.output<typeof CustomerSchema>;
/** A customer's detail on the wire. */
export type WireCustomerDetail = z.output<typeof CustomerDetailSchema>;
/** The store account on the wire. */
export type WireStoreMe = z.output<typeof StoreMeSchema>;
/** A store order on the wire. */
export type WireStoreOrder = z.output<typeof StoreOrderSchema>;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * Builds the list row of a customer.
 *
 * Why: the console's `Customer`: the stored columns, the currency as id plus code (B148) and the order figures.
 *
 * @param row the customer with its currency id and order figures
 * @returns the wire row
 */
export function toWireCustomer(row: CustomerRow): WireCustomer {
  const c = row.customer;
  return {
    id: c.id,
    email: c.email,
    emailVerifiedAt: iso(c.emailVerifiedAt),
    name: c.name,
    phone: c.phone,
    country: c.country,
    locale: c.locale,
    currency: row.currencyId,
    currencyCode: c.currency,
    hasAccount: c.hasAccount,
    createdBy: c.createdBy,
    marketingOptIn: c.marketingOptIn,
    riskLevel: c.riskLevel,
    status: c.status,
    suspendedAt: iso(c.suspendedAt),
    suspendedReason: c.suspendedReason,
    suspendedBy: c.suspendedBy,
    internalNotes: c.internalNotes,
    lastLoginAt: iso(c.lastLoginAt),
    firstOrderAt: iso(c.firstOrderAt),
    totalSpent: c.totalSpent,
    anonymizedAt: iso(c.anonymizedAt),
    createdAt: c.createdAt.toISOString(),
    ordersCount: row.ordersCount,
    lastOrderAt: iso(row.lastOrderAt),
  };
}

/** What the detail adds to the row. */
export interface DetailParts {
  readonly counts: DetailCounts;
  readonly risk: RiskSummary;
  readonly consents: { orderId: number; records: ConsentEvidence[] } | null;
  /** The sign-in side; `null` for a guest. */
  readonly account: {
    readonly mustChangePassword: boolean;
    readonly passwordChangedAt: Date | null;
    readonly resetSentAt: Date | null;
    readonly activeSessions: number;
    readonly lastIp: string | null;
  } | null;
}

/**
 * Builds the detail of a customer.
 *
 * @param row the customer with its currency id and order figures
 * @param parts the counts, risk, consent evidence and sign-in side read for the detail
 * @returns the wire detail
 */
export function toWireDetail(row: CustomerRow, parts: DetailParts): WireCustomerDetail {
  const base = toWireCustomer(row);
  return {
    ...base,
    stats: {
      orders: row.ordersCount,
      spent: base.totalSpent,
      lastOrderAt: base.lastOrderAt,
      refunds: parts.counts.refunds,
      tickets: parts.counts.tickets,
      disputes: parts.counts.disputes,
    },
    account:
      parts.account === null
        ? null
        : {
            emailVerified: row.customer.emailVerifiedAt !== null,
            mustChangePassword: parts.account.mustChangePassword,
            passwordChangedAt: iso(parts.account.passwordChangedAt),
            resetSentAt: iso(parts.account.resetSentAt),
            activeSessions: parts.account.activeSessions,
            lastIp: parts.account.lastIp,
          },
    latestConsents:
      parts.consents === null
        ? null
        : {
            orderId: parts.consents.orderId,
            records: parts.consents.records.map((record) => ({
              purpose: record.purpose,
              document: documentLabel(record.documentType, record.documentVersion),
              at: record.at.toISOString(),
              ip: record.ip,
            })),
          },
    risk: { highestScore: parts.risk.highestScore, signals: parts.risk.signals.map((signal) => ({ ...signal })) },
  };
}

/**
 * Builds the account the storefront shows its signed-in customer.
 *
 * @param customer the customer row
 * @param hasPassword whether the customer has chosen a password
 * @returns the wire account
 */
export function toStoreMe(customer: Customer, hasPassword: boolean): WireStoreMe {
  return {
    id: customer.id,
    email: customer.email,
    emailVerifiedAt: iso(customer.emailVerifiedAt),
    name: customer.name,
    phone: customer.phone,
    country: customer.country,
    locale: customer.locale,
    currency: customer.currency,
    marketingOptIn: customer.marketingOptIn,
    hasPassword,
    createdAt: customer.createdAt.toISOString(),
  };
}

/**
 * Builds one of the customer's orders for the store account.
 *
 * @param row the order read for the account
 * @returns the wire order (an erased IMEI is sent as an empty string)
 */
export function toStoreOrder(row: StoreOrderRow): WireStoreOrder {
  return {
    id: row.id,
    status: row.status,
    service: { id: row.serviceId, name: row.serviceName },
    imei: row.imei ?? '',
    quantity: row.quantity,
    totalPrice: row.totalPrice,
    taxAmount: row.taxAmount,
    currency: row.currency,
    trackingToken: row.publicToken,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
  };
}
