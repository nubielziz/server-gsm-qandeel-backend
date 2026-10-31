// Money tables (map domain E): currencies, the double-entry ledger, invoices, gateways, payments, refunds, disputes.
// Conventions: decisions 011, 024, 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
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
  bigintList,
  createdAt,
  fk,
  fxRate,
  inList,
  jsonObject,
  money,
  percent,
  pk,
  timestampTz,
  updatedAt,
} from '../../../infra/db/columns';
import { customers } from '../../customers/db/schema';
import { clients, staffUsers } from '../../identity/db/schema';
import { orders } from '../../orders/db/schema';
import { files } from '../../platform/db/schema';

/**
 * The 15 ledger account kinds: 11 system accounts, `owner_capital` (equity, counterpart of opening balances), and the
 * per-owner `client_wallet`, `client_hold` and `supplier_prepaid`.
 *
 * Why: decision 024 (the map's 14 accounts plus owner_capital, MISMATCHES B35).
 */
export const LEDGER_ACCOUNT_KINDS = [
  'fee_income',
  'vat_payable',
  'chargeback_loss',
  'bank',
  'gateway_fees',
  'gateway_clearing',
  'customer_funds',
  'revenue',
  'cogs',
  'adjustments',
  'commission_expense',
  'owner_capital',
  'client_wallet',
  'client_hold',
  'supplier_prepaid',
] as const;

/** One value of {@link LEDGER_ACCOUNT_KINDS}. */
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];

/**
 * Who owns a per-owner ledger account.
 *
 * Why: the console's ledger wire enum; decision 024 only creates client and supplier accounts today.
 */
export const LEDGER_OWNER_TYPES = ['client', 'supplier', 'customer'] as const;

/** One value of {@link LEDGER_OWNER_TYPES}. */
export type LedgerOwnerType = (typeof LEDGER_OWNER_TYPES)[number];

/**
 * What a ledger transaction points at through `ref_id`.
 *
 * Why: decision 024 and MISMATCHES B34: the map lists four, the console finds deposits and commission batches too.
 */
export const LEDGER_REF_TYPES = [
  'order',
  'payment',
  'invoice',
  'refund',
  'dispute',
  'accrual',
  'supplier',
  'client',
  'system',
  'ledger_transaction',
] as const;

/** One value of {@link LEDGER_REF_TYPES}. */
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];

/**
 * Who posted a ledger transaction.
 *
 * Why: the console's ledger wire enum (GET /admin/ledger/transactions).
 */
export const LEDGER_ACTOR_TYPES = ['staff', 'client', 'customer', 'system'] as const;

/** One value of {@link LEDGER_ACTOR_TYPES}. */
export type LedgerActorType = (typeof LEDGER_ACTOR_TYPES)[number];

/**
 * Invoice kinds: wallet top-up, manual, B2C tax receipt and statement.
 *
 * Why: the console's invoice wire enum (GET /admin/invoices).
 */
export const INVOICE_KINDS = ['topup', 'manual', 'receipt', 'statement'] as const;

/** One value of {@link INVOICE_KINDS}. */
export type InvoiceKind = (typeof INVOICE_KINDS)[number];

/**
 * Invoice states.
 *
 * Why: the console's invoice wire enum.
 */
export const INVOICE_STATUSES = ['open', 'paid', 'void'] as const;

/** One value of {@link INVOICE_STATUSES}. */
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Which channel a payment gateway serves.
 *
 * Why: the console's gateway wire enum (GET /admin/payment-gateways).
 */
export const GATEWAY_AUDIENCES = ['b2b', 'b2c', 'both'] as const;

/** One value of {@link GATEWAY_AUDIENCES}. */
export type GatewayAudience = (typeof GATEWAY_AUDIENCES)[number];

/**
 * What a payment pays for: a wallet top-up or a B2C order.
 *
 * Why: the console's payment wire enum (GET /admin/payments).
 */
export const PAYMENT_PURPOSES = ['topup', 'order'] as const;

/** One value of {@link PAYMENT_PURPOSES}. */
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

/**
 * Refund states; `processing` is internal (the gateway call is in flight) and reaches the console as completed.
 *
 * Why: the console's refund wire enum plus `processing` of MISMATCHES B82.
 */
export const REFUND_STATUSES = ['requested', 'processing', 'completed', 'failed', 'rejected'] as const;

/** One value of {@link REFUND_STATUSES}. */
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * Who asked for a refund.
 *
 * Why: the console's refund wire enum.
 */
export const REFUND_REQUESTER_TYPES = ['staff', 'customer', 'system'] as const;

/** One value of {@link REFUND_REQUESTER_TYPES}. */
export type RefundRequesterType = (typeof REFUND_REQUESTER_TYPES)[number];

/**
 * Chargeback dispute states.
 *
 * Why: the console's dispute wire enum and scenario b2c-chargeback.
 */
export const DISPUTE_STATUSES = ['needs_response', 'under_review', 'won', 'lost'] as const;

/** One value of {@link DISPUTE_STATUSES}. */
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

/**
 * Currencies and exchange rates, with a markup and psychological (charm) rounding for the storefront display.
 *
 * Why: Offered currencies and FX rates; the ledger itself stays in the base currency (decision 011, routes
 * /admin/currencies).
 */
export const currencies = pgTable(
  'currencies',
  {
    id: pk(),
    /** ISO code, unique; other tables reference it as `currency` */
    code: text().notNull(),
    name: text().notNull(),
    rateToBase: fxRate().notNull().default('1'),
    rateUpdatedAt: timestampTz().notNull().defaultNow(),
    markupPercent: percent().notNull().default('0'),
    charmRounding: boolean().notNull().default(false),
    isStorefront: boolean().notNull().default(false),
    /** fraction digits shown for the currency (0 to 8) */
    decimals: integer().notNull().default(2),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('currencies_code_uq').on(t.code),
    check('currencies_rate_check', sql`${t.rateToBase} > 0`),
    check('currencies_decimals_check', sql`${t.decimals} between 0 and 8`),
  ],
);

/** A row read from `currencies`. */
export type Currency = typeof currencies.$inferSelect;

/** A row to insert into `currencies`. */
export type NewCurrency = typeof currencies.$inferInsert;

/**
 * Accounts: wallet, hold, revenue, customer funds and tax payable.
 *
 * Why: Balances of the double-entry ledger: system accounts plus one wallet, hold and prepaid account per owner
 * (decision 024).
 */
export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: pk(),
    kind: text().$type<LedgerAccountKind>().notNull(),
    /** null for system accounts */
    ownerType: text().$type<LedgerOwnerType>(),
    /** polymorphic: clients or suppliers by owner_type; null for system accounts */
    ownerId: bigId(),
    currency: text()
      .references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' })
      .notNull(),
    /** kept in the account's normal sign (decision 024) */
    balance: money().notNull().default('0'),
    /** merchant credit limit on client_wallet accounts */
    overdraftLimit: money().notNull().default('0'),
    /** incremented with every posting */
    version: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('ledger_accounts_identity_uq').on(t.kind, t.ownerType, t.ownerId, t.currency).nullsNotDistinct(),
    check('ledger_accounts_kind_check', inList(t.kind, LEDGER_ACCOUNT_KINDS)),
    check('ledger_accounts_owner_type_check', inList(t.ownerType, LEDGER_OWNER_TYPES)),
    index('ledger_accounts_owner_idx').on(t.ownerType, t.ownerId),
    check('ledger_accounts_owner_check', sql`(${t.ownerType} is null) = (${t.ownerId} is null)`),
    check(
      'ledger_accounts_kind_owner_check',
      sql`(${t.kind} in ('client_wallet', 'client_hold') and ${t.ownerType} is not distinct from 'client')
 or (${t.kind} = 'supplier_prepaid' and ${t.ownerType} is not distinct from 'supplier')
 or (${t.kind} not in ('client_wallet', 'client_hold', 'supplier_prepaid') and ${t.ownerType} is null)`,
    ),
    check('ledger_accounts_overdraft_check', sql`${t.overdraftLimit} >= 0`),
    index('ledger_accounts_currency_idx').on(t.currency),
  ],
);

/** A row read from `ledger_accounts`. */
export type LedgerAccount = typeof ledgerAccounts.$inferSelect;

/** A row to insert into `ledger_accounts`. */
export type NewLedgerAccount = typeof ledgerAccounts.$inferInsert;

/**
 * The journal entry header, with an idempotency key.
 *
 * Why: Header of every money event; the unique idempotency key makes a replay post nothing (decision 024).
 *
 * Append-only: a trigger rejects UPDATE and DELETE (custom migration); corrections are reversing transactions.
 */
export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: pk(),
    /**
     * the money event (deposit, order, complete, ...); reversals add kinds, so no source fixes the full list
     */
    kind: text().notNull(),
    refType: text().$type<LedgerRefType>().notNull(),
    /** polymorphic by ref_type; null for system postings */
    refId: bigId(),
    memo: text().notNull().default(''),
    idempotencyKey: text().notNull(),
    createdByType: text().$type<LedgerActorType>().notNull(),
    /** staff_users, clients or customers by created_by_type; null when the system posted */
    createdById: bigId(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_transactions_idempotency_key_uq').on(t.idempotencyKey),
    check('ledger_transactions_ref_type_check', inList(t.refType, LEDGER_REF_TYPES)),
    check('ledger_transactions_created_by_type_check', inList(t.createdByType, LEDGER_ACTOR_TYPES)),
    index('ledger_transactions_ref_idx').on(t.refType, t.refId),
    index('ledger_transactions_kind_idx').on(t.kind, t.createdAt.desc()),
    index('ledger_transactions_created_idx').on(t.createdAt.desc()),
    check('ledger_transactions_actor_check', sql`(${t.createdByType} = 'system') = (${t.createdById} is null)`),
  ],
);

/** A row read from `ledger_transactions`. */
export type LedgerTransaction = typeof ledgerTransactions.$inferSelect;

/** A row to insert into `ledger_transactions`. */
export type NewLedgerTransaction = typeof ledgerTransactions.$inferInsert;

/**
 * Journal entry lines; they always sum to zero.
 *
 * Why: Journal lines; a deferred constraint trigger keeps every transaction at zero sum (decision 024).
 *
 * Append-only: a trigger rejects UPDATE and DELETE, and a deferred constraint trigger checks that the lines of a
 * transaction sum to zero at commit (custom migration).
 */
export const ledgerEntries = pgTable(
  'ledger_entries',
  {
    id: pk(),
    transactionId: fk((): AnyPgColumn => ledgerTransactions.id).notNull(),
    accountId: fk((): AnyPgColumn => ledgerAccounts.id).notNull(),
    /** signed: debit above zero, credit below zero */
    amount: money().notNull(),
    /** the account balance (normal sign) right after this line */
    balanceAfter: money().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index('ledger_entries_transaction_id_idx').on(t.transactionId),
    index('ledger_entries_account_idx').on(t.accountId, t.id),
    check('ledger_entries_amount_check', sql`${t.amount} <> 0`),
  ],
);

/** A row read from `ledger_entries`. */
export type LedgerEntry = typeof ledgerEntries.$inferSelect;

/** A row to insert into `ledger_entries`. */
export type NewLedgerEntry = typeof ledgerEntries.$inferInsert;

/**
 * Top-up invoices and statements, and B2C tax receipts with a PDF copy.
 *
 * Why: Wallet top-up invoices, statements and B2C tax receipts (routes /admin/invoices, /client/invoices).
 */
export const invoices = pgTable(
  'invoices',
  {
    id: pk(),
    number: text().notNull(),
    /** B2B invoices */
    clientId: fk((): AnyPgColumn => clients.id),
    /** B2C receipts */
    customerId: fk((): AnyPgColumn => customers.id),
    orderId: fk((): AnyPgColumn => orders.id),
    kind: text().$type<InvoiceKind>().notNull(),
    amount: money().notNull(),
    fee: money().notNull().default('0'),
    netAmount: money(),
    taxAmount: money(),
    taxRate: percent(),
    taxCountry: text(),
    /** the buyer's VAT number (text, not a database id) */
    customerVatId: text(),
    total: money().notNull(),
    currency: text()
      .references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' })
      .notNull(),
    status: text().$type<InvoiceStatus>().notNull().default('open'),
    gatewayId: fk((): AnyPgColumn => paymentGateways.id),
    pdfFileId: fk((): AnyPgColumn => files.id),
    dueAt: timestampTz(),
    paidAt: timestampTz(),
    /** schema addition B116 */
    description: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('invoices_number_uq').on(t.number),
    check('invoices_kind_check', inList(t.kind, INVOICE_KINDS)),
    check('invoices_status_check', inList(t.status, INVOICE_STATUSES)),
    index('invoices_client_created_idx').on(t.clientId, t.createdAt.desc()),
    index('invoices_status_created_idx').on(t.status, t.createdAt.desc()),
    index('invoices_created_idx').on(t.createdAt.desc()),
    check('invoices_amount_check', sql`${t.amount} >= 0 and ${t.fee} >= 0`),
    index('invoices_customer_id_idx').on(t.customerId),
    index('invoices_order_id_idx').on(t.orderId),
    index('invoices_currency_idx').on(t.currency),
    index('invoices_gateway_id_idx').on(t.gatewayId),
    index('invoices_pdf_file_id_idx').on(t.pdfFileId),
  ],
);

/** A row read from `invoices`. */
export type Invoice = typeof invoices.$inferSelect;

/** A row to insert into `invoices`. */
export type NewInvoice = typeof invoices.$inferInsert;

/**
 * Payment gateways with their fees and limits, split by audience (B2B or B2C).
 *
 * Why: Payment gateways with fees, limits and audience; credentials are encrypted (routes /admin/payment-gateways).
 */
export const paymentGateways = pgTable(
  'payment_gateways',
  {
    id: pk(),
    /** unique */
    code: text().notNull(),
    driver: text().notNull(),
    name: text().notNull(),
    audience: text().$type<GatewayAudience>().notNull().default('both'),
    /** driver credentials, decision 019 format; null for manual gateways */
    configEnc: text(),
    /** decision 019 format; null for manual gateways */
    webhookSecretEnc: text(),
    feePercent: percent().notNull().default('0'),
    feeFixed: money().notNull().default('0'),
    minAmount: money().notNull().default('0'),
    maxAmount: money().notNull().default('0'),
    /** client_groups.id; empty means every group */
    allowedGroupIds: bigintList(),
    supportsRefunds: boolean().notNull().default(false),
    supports3ds: boolean('supports_3ds').notNull().default(false),
    isManual: boolean().notNull().default(false),
    instructions: text().notNull().default(''),
    holdHours: integer().notNull().default(0),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payment_gateways_code_uq').on(t.code),
    check('payment_gateways_audience_check', inList(t.audience, GATEWAY_AUDIENCES)),
    check('payment_gateways_fee_check', sql`${t.feePercent} between 0 and 100 and ${t.feeFixed} >= 0`),
    check('payment_gateways_limits_check', sql`${t.minAmount} >= 0 and ${t.maxAmount} >= 0`),
  ],
);

/** A row read from `payment_gateways`. */
export type PaymentGateway = typeof paymentGateways.$inferSelect;

/** A row to insert into `payment_gateways`. */
export type NewPaymentGateway = typeof paymentGateways.$inferInsert;

/**
 * Payments and their confirmation: a wallet top-up or a B2C order payment.
 *
 * Why: Payments and their confirmation: wallet top-ups and B2C order payments (scenario b2c-paid, money event
 * deposit).
 */
export const payments = pgTable(
  'payments',
  {
    id: pk(),
    invoiceId: fk((): AnyPgColumn => invoices.id),
    customerId: fk((): AnyPgColumn => customers.id),
    orderId: fk((): AnyPgColumn => orders.id),
    purpose: text().$type<PaymentPurpose>().notNull(),
    gatewayId: fk((): AnyPgColumn => paymentGateways.id).notNull(),
    /** the gateway's reference, kept as text; unique per gateway */
    gatewayTxnId: text(),
    amount: money().notNull(),
    feeAmount: money().notNull().default('0'),
    currency: text()
      .references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' })
      .notNull(),
    /** captured, pending, ...; no source fixes the full list (B37 leaves the vocabulary open) */
    status: text().notNull(),
    /** bank, card, usdt, wise, wallet or crypto; the wire enums of top-ups and B2C payments differ */
    methodType: text().notNull(),
    threeDs: boolean().notNull().default(false),
    capturedAt: timestampTz(),
    receiptFileId: fk((): AnyPgColumn => files.id),
    /** the gateway payload, kept for support and disputes */
    raw: jsonObject(),
    reviewedBy: fk((): AnyPgColumn => staffUsers.id),
    /** schema addition B116 */
    reviewedAt: timestampTz(),
    /** schema addition B116 */
    reviewNote: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payments_gateway_txn_uq')
      .on(t.gatewayId, t.gatewayTxnId)
      .where(sql`${t.gatewayTxnId} is not null`),
    check('payments_purpose_check', inList(t.purpose, PAYMENT_PURPOSES)),
    index('payments_purpose_status_created_idx').on(t.purpose, t.status, t.createdAt.desc()),
    index('payments_customer_id_idx').on(t.customerId),
    check('payments_amount_check', sql`${t.amount} > 0 and ${t.feeAmount} >= 0`),
    index('payments_invoice_id_idx').on(t.invoiceId),
    index('payments_order_id_idx').on(t.orderId),
    index('payments_gateway_id_idx').on(t.gatewayId),
    index('payments_currency_idx').on(t.currency),
    index('payments_receipt_file_id_idx').on(t.receiptFileId),
    index('payments_reviewed_by_idx').on(t.reviewedBy),
  ],
);

/** A row read from `payments`. */
export type Payment = typeof payments.$inferSelect;

/** A row to insert into `payments`. */
export type NewPayment = typeof payments.$inferInsert;

/**
 * Withdrawal requests, for a later phase.
 *
 * Why: Merchant withdrawal requests; no route uses the table yet (the map keeps it for a later phase).
 */
export const withdrawalRequests = pgTable(
  'withdrawal_requests',
  {
    id: pk(),
    clientId: fk((): AnyPgColumn => clients.id).notNull(),
    amount: money().notNull(),
    /** no source fixes the values yet (later phase) */
    method: text().notNull(),
    destination: text().notNull(),
    /** no source fixes the values yet (later phase) */
    status: text().notNull(),
    decidedBy: fk((): AnyPgColumn => staffUsers.id),
    decidedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('withdrawal_requests_amount_check', sql`${t.amount} > 0`),
    index('withdrawal_requests_client_id_idx').on(t.clientId),
    index('withdrawal_requests_decided_by_idx').on(t.decidedBy),
  ],
);

/** A row read from `withdrawal_requests`. */
export type WithdrawalRequest = typeof withdrawalRequests.$inferSelect;

/** A row to insert into `withdrawal_requests`. */
export type NewWithdrawalRequest = typeof withdrawalRequests.$inferInsert;

/**
 * Refunds: full or partial, to the card, the wallet or store credit.
 *
 * Why: B2C refunds and system-approved refunds on rejection (scenario b2c-refund, routes /admin/refunds).
 */
export const refunds = pgTable(
  'refunds',
  {
    id: pk(),
    paymentId: fk((): AnyPgColumn => payments.id),
    orderId: fk((): AnyPgColumn => orders.id),
    customerId: fk((): AnyPgColumn => customers.id),
    clientId: fk((): AnyPgColumn => clients.id),
    amount: money().notNull(),
    currency: text()
      .references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' })
      .notNull(),
    reason: text().notNull().default(''),
    /** the map says card, wallet or store credit while the wire says original or manual (B81) */
    method: text().notNull(),
    status: text().$type<RefundStatus>().notNull().default('requested'),
    /** the gateway's reference, kept as text */
    gatewayRefundId: text(),
    requestedByType: text().$type<RefundRequesterType>().notNull(),
    /** customers or staff_users by requested_by_type; null for the system */
    requestedById: bigId(),
    approvedBy: fk((): AnyPgColumn => staffUsers.id),
    ledgerTxId: fk((): AnyPgColumn => ledgerTransactions.id),
    completedAt: timestampTz(),
    /** schema addition B116 */
    note: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('refunds_status_check', inList(t.status, REFUND_STATUSES)),
    check('refunds_requested_by_type_check', inList(t.requestedByType, REFUND_REQUESTER_TYPES)),
    index('refunds_status_created_idx').on(t.status, t.createdAt.desc()),
    index('refunds_created_idx').on(t.createdAt.desc()),
    check('refunds_amount_check', sql`${t.amount} > 0`),
    check('refunds_requester_check', sql`(${t.requestedByType} = 'system') = (${t.requestedById} is null)`),
    index('refunds_payment_id_idx').on(t.paymentId),
    index('refunds_order_id_idx').on(t.orderId),
    index('refunds_customer_id_idx').on(t.customerId),
    index('refunds_client_id_idx').on(t.clientId),
    index('refunds_currency_idx').on(t.currency),
    index('refunds_approved_by_idx').on(t.approvedBy),
    index('refunds_ledger_tx_id_idx').on(t.ledgerTxId),
  ],
);

/** A row read from `refunds`. */
export type Refund = typeof refunds.$inferSelect;

/** A row to insert into `refunds`. */
export type NewRefund = typeof refunds.$inferInsert;

/**
 * Chargeback disputes: the deadline, the evidence pack and the outcome.
 *
 * Why: Chargebacks with the evidence deadline and outcome (scenario b2c-chargeback, routes /admin/disputes).
 */
export const disputes = pgTable(
  'disputes',
  {
    id: pk(),
    paymentId: fk((): AnyPgColumn => payments.id).notNull(),
    orderId: fk((): AnyPgColumn => orders.id),
    customerId: fk((): AnyPgColumn => customers.id),
    /** the gateway's reference, kept as text; unique per payment */
    gatewayDisputeId: text().notNull(),
    reasonCode: text().notNull(),
    amount: money().notNull(),
    currency: text()
      .references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' })
      .notNull(),
    fee: money().notNull().default('0'),
    status: text().$type<DisputeStatus>().notNull().default('needs_response'),
    evidenceDueAt: timestampTz().notNull(),
    /** files.id of the evidence pack */
    evidenceFileIds: bigintList(),
    submittedAt: timestampTz(),
    resolvedAt: timestampTz(),
    ledgerTxId: fk((): AnyPgColumn => ledgerTransactions.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('disputes_gateway_dispute_uq').on(t.paymentId, t.gatewayDisputeId),
    check('disputes_status_check', inList(t.status, DISPUTE_STATUSES)),
    index('disputes_status_due_idx').on(t.status, t.evidenceDueAt),
    index('disputes_evidence_due_idx').on(t.evidenceDueAt),
    check('disputes_amount_check', sql`${t.amount} > 0 and ${t.fee} >= 0`),
    index('disputes_order_id_idx').on(t.orderId),
    index('disputes_customer_id_idx').on(t.customerId),
    index('disputes_currency_idx').on(t.currency),
    index('disputes_ledger_tx_id_idx').on(t.ledgerTxId),
  ],
);

/** A row read from `disputes`. */
export type Dispute = typeof disputes.$inferSelect;

/** A row to insert into `disputes`. */
export type NewDispute = typeof disputes.$inferInsert;

/**
 * Tax rates per country for digital services, including the OSS scheme.
 *
 * Why: VAT and OSS rates per country for digital services (routes /admin/tax-rates, scenario b2c-paid).
 */
export const taxRates = pgTable(
  'tax_rates',
  {
    id: pk(),
    /** ISO country code */
    country: text().notNull(),
    region: text().notNull().default(''),
    ratePercent: percent().notNull(),
    /** vat or none in the demo; no source fixes the list */
    taxType: text().notNull(),
    /** digital_services in the demo; no source fixes the list */
    appliesTo: text().notNull(),
    validFrom: timestampTz().notNull().defaultNow(),
    validTo: timestampTz(),
    label: text().notNull().default(''),
    ossScheme: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('tax_rates_country_valid_idx').on(t.country, t.validFrom.desc()),
    check('tax_rates_rate_check', sql`${t.ratePercent} between 0 and 100`),
    check('tax_rates_validity_check', sql`${t.validTo} is null or ${t.validTo} > ${t.validFrom}`),
  ],
);

/** A row read from `tax_rates`. */
export type TaxRate = typeof taxRates.$inferSelect;

/** A row to insert into `tax_rates`. */
export type NewTaxRate = typeof taxRates.$inferInsert;
