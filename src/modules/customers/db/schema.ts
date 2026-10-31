// Customers tables (map domain I): storefront customers, sign-in data, checkout sessions and consents.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  bigId,
  createdAt,
  fk,
  fxRate,
  inList,
  jsonObject,
  lower,
  money,
  percent,
  pk,
  timestampTz,
  updatedAt,
} from '../../../infra/db/columns';
import { services } from '../../catalog/db/schema';
import { staffUsers } from '../../identity/db/schema';
import { currencies } from '../../money/db/schema';
import { orders } from '../../orders/db/schema';
import { legalDocuments } from '../../storefront/db/schema';

/**
 * Customer states: `suspended` is a reversible pause, `blocked` is fraud, `anonymized` is final.
 *
 * Why: the console's customer wire enum (GET /admin/customers).
 */
export const CUSTOMER_STATUSES = ['active', 'suspended', 'blocked', 'anonymized'] as const;

/** One value of {@link CUSTOMER_STATUSES}. */
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

/**
 * Risk level of a customer.
 *
 * Why: the console's customer wire enum.
 */
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

/** One value of {@link RISK_LEVELS}. */
export type RiskLevel = (typeof RISK_LEVELS)[number];

/**
 * Storefront customers: a guest with an email, or an account with a password or a sign-in link. Status is active,
 * suspended (a reversible pause), blocked (fraud) or anonymized.
 *
 * Why: B2C buyers: a guest with an email or an account (scenario b2c-account, routes /admin/customers).
 */
export const customers = pgTable(
  'customers',
  {
    id: pk(),
    /** unique case-insensitively */
    email: text().notNull(),
    emailVerifiedAt: timestampTz(),
    name: text().notNull().default(''),
    phone: text().notNull().default(''),
    country: text().notNull().default(''),
    locale: text().notNull().default('en'),
    /** preferred display currency */
    currency: text().references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' }),
    hasAccount: boolean().notNull().default(false),
    /** the staff member who created the account for the customer */
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    marketingOptIn: boolean().notNull().default(false),
    riskLevel: text().$type<RiskLevel>().notNull().default('low'),
    status: text().$type<CustomerStatus>().notNull().default('active'),
    suspendedAt: timestampTz(),
    suspendedReason: text(),
    suspendedBy: fk((): AnyPgColumn => staffUsers.id),
    internalNotes: text().notNull().default(''),
    lastLoginAt: timestampTz(),
    firstOrderAt: timestampTz(),
    totalSpent: money().notNull().default('0'),
    anonymizedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('customers_email_uq').on(lower(t.email)),
    check('customers_risk_level_check', inList(t.riskLevel, RISK_LEVELS)),
    check('customers_status_check', inList(t.status, CUSTOMER_STATUSES)),
    index('customers_status_idx').on(t.status),
    index('customers_total_spent_idx').on(t.totalSpent.desc()),
    index('customers_risk_level_idx').on(t.riskLevel),
    index('customers_country_idx').on(t.country),
    index('customers_currency_idx').on(t.currency),
    index('customers_created_by_idx').on(t.createdBy),
    index('customers_suspended_by_idx').on(t.suspendedBy),
  ],
);

/** A row read from `customers`. */
export type Customer = typeof customers.$inferSelect;

/** A row to insert into `customers`. */
export type NewCustomer = typeof customers.$inferInsert;

/**
 * Account sign-in data, kept apart from the profile: hash only. A temporary password set by a staff member forces a
 * change at first sign-in, and nobody can read the current password.
 *
 * Why: Sign-in data kept apart from the profile: hash only, with lockout counters (decision 018).
 */
export const customerCredentials = pgTable(
  'customer_credentials',
  {
    id: pk(),
    customerId: fk((): AnyPgColumn => customers.id, 'cascade').notNull(),
    /** null until the customer chooses a password */
    passwordHash: text(),
    mustChangePassword: boolean().notNull().default(false),
    passwordChangedAt: timestampTz(),
    failedAttempts: integer().notNull().default(0),
    lockedUntil: timestampTz(),
    updatedBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('customer_credentials_customer_uq').on(t.customerId),
    index('customer_credentials_updated_by_idx').on(t.updatedBy),
  ],
);

/** A row read from `customer_credentials`. */
export type CustomerCredential = typeof customerCredentials.$inferSelect;

/** A row to insert into `customer_credentials`. */
export type NewCustomerCredential = typeof customerCredentials.$inferInsert;

/**
 * The payment session before any order exists: the price, tax and exchange rate are locked in, and the order is
 * created after payment.
 *
 * Why: The payment session before any order exists: price, tax and FX are locked, the order is created after payment
 * (scenario b2c-paid).
 */
export const checkoutSessions = pgTable(
  'checkout_sessions',
  {
    id: pk(),
    /** capability token of the checkout link (decision 010); unique */
    token: text().notNull(),
    customerId: fk((): AnyPgColumn => customers.id),
    email: text().notNull(),
    serviceId: fk((): AnyPgColumn => services.id).notNull(),
    /** the IMEI, AES-GCM text of decision 019 */
    imeiEnc: text(),
    inputs: jsonObject(),
    quantity: integer().notNull().default(1),
    currency: text()
      .references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' })
      .notNull(),
    /** locked at session start */
    fxRate: fxRate().notNull().default('1'),
    netAmount: money().notNull(),
    taxRate: percent().notNull().default('0'),
    taxAmount: money().notNull().default('0'),
    grossAmount: money().notNull(),
    taxCountry: text(),
    utm: jsonObject(),
    ip: text(),
    userAgent: text().notNull().default(''),
    /** open, paid, expired, ...; no source fixes the values */
    status: text().notNull(),
    expiresAt: timestampTz().notNull(),
    /** set when the payment created the order */
    orderId: fk((): AnyPgColumn => orders.id),
    recoveryEmailedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('checkout_sessions_token_uq').on(t.token),
    index('checkout_sessions_status_created_idx').on(t.status, t.createdAt.desc()),
    index('checkout_sessions_created_idx').on(t.createdAt.desc()),
    index('checkout_sessions_customer_id_idx').on(t.customerId),
    check('checkout_sessions_quantity_check', sql`${t.quantity} > 0 and ${t.grossAmount} >= 0`),
    index('checkout_sessions_service_id_idx').on(t.serviceId),
    index('checkout_sessions_currency_idx').on(t.currency),
    index('checkout_sessions_order_id_idx').on(t.orderId),
  ],
);

/** A row read from `checkout_sessions`. */
export type CheckoutSession = typeof checkoutSessions.$inferSelect;

/** A row to insert into `checkout_sessions`. */
export type NewCheckoutSession = typeof checkoutSessions.$inferInsert;

/**
 * Proof of consent: terms, privacy, marketing and the withdrawal-right waiver, with the IP address and the time.
 *
 * Why: Proof of consent to terms, privacy, marketing and the withdrawal waiver, with IP and time (scenario b2c-paid).
 *
 * Immutable proof: a withdrawn consent is a new row with `granted = false`, so the table has no `updated_at`.
 */
export const consentRecords = pgTable(
  'consent_records',
  {
    id: pk(),
    /** customer or client; no source fixes the strings */
    subjectType: text().notNull(),
    /** polymorphic: customers or clients by subject_type */
    subjectId: bigId().notNull(),
    legalDocumentId: fk((): AnyPgColumn => legalDocuments.id),
    /** terms, privacy, marketing or the withdrawal waiver; no source fixes the strings */
    purpose: text().notNull(),
    granted: boolean().notNull().default(false),
    checkoutSessionId: fk((): AnyPgColumn => checkoutSessions.id),
    orderId: fk((): AnyPgColumn => orders.id),
    ip: text(),
    userAgent: text().notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [
    index('consent_records_subject_idx').on(t.subjectType, t.subjectId, t.purpose, t.createdAt.desc()),
    index('consent_records_legal_document_id_idx').on(t.legalDocumentId),
    index('consent_records_checkout_session_id_idx').on(t.checkoutSessionId),
    index('consent_records_order_id_idx').on(t.orderId),
  ],
);

/** A row read from `consent_records`. */
export type ConsentRecord = typeof consentRecords.$inferSelect;

/** A row to insert into `consent_records`. */
export type NewConsentRecord = typeof consentRecords.$inferInsert;
