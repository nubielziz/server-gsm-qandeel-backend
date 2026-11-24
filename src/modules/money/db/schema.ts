// Money tables (map domain E): currencies, the double-entry ledger, invoices, gateways, payments, refunds, disputes.
// Conventions: decisions 011, 024, 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
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
import { checkoutSessions, retiredCustomers } from '../../customers/db/schema';
import { clients, staffUsers } from '../../identity/db/schema';
import { orders } from '../../orders/db/schema';
import { files } from '../../platform/db/schema';

/**
 * The 16 ledger account kinds: 11 system accounts, `owner_capital` (equity, counterpart of opening balances), and the
 * per-owner `client_wallet`, `client_hold`, `supplier_prepaid` and `customer_wallet`.
 *
 * Why: decision 024 (the map's 14 accounts plus owner_capital, MISMATCHES B35); feature 21 adds the store balance
 * `customer_wallet` (a liability, USD). Decision 064: the wallet kind follows the account's rank (a merchant rank has `client_wallet`
 * and `client_hold`, a retail rank has `customer_wallet`), and the owner of every one of them is an account.
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
  'customer_wallet',
] as const;

/** One value of {@link LEDGER_ACCOUNT_KINDS}. */
export type LedgerAccountKind = (typeof LEDGER_ACCOUNT_KINDS)[number];

/**
 * Who owns a per-owner ledger account: an account (of any rank) or a supplier.
 *
 * Why: the console's ledger wire enum; decision 064 rewrote the owner words `client` and `customer` to `account` (the ledger account rows
 * are mutable, so the expand migration rewrites them in place; no entry or transaction row changes).
 */
export const LEDGER_OWNER_TYPES = ['account', 'supplier'] as const;

/** One value of {@link LEDGER_OWNER_TYPES}. */
export type LedgerOwnerType = (typeof LEDGER_OWNER_TYPES)[number];

/**
 * Every word `ledger_transactions.ref_type` may hold, the old ones included: what a ledger transaction points at through `ref_id`.
 *
 * Why: decision 024 and MISMATCHES B34: the map lists four, the console finds deposits and commission batches too.
 * RESOLUTIONS money-1 drops `ledger_transaction`: a reversal points at the original's own `ref_type` and `ref_id`. Feature 21
 * adds `customer` (a staff adjustment of a customer's store balance; sent as `system` like `client`). The table is append-only, so the
 * rows written before decision 064 keep `client` and `customer` (read through `account_legacy_ids`) and the CHECK only gained `account`.
 * New rows may write {@link CURRENT_LEDGER_REF_TYPES} only.
 */
export const LEDGER_REF_TYPES = [
  'order',
  'payment',
  'invoice',
  'refund',
  'dispute',
  // Only the journals of the retired commissions carry `accrual` (decision 062); nothing posts it any more, every reader keeps it valid.
  'accrual',
  'supplier',
  'client',
  'customer',
  'system',
  'account',
] as const;

/** One value of {@link LEDGER_REF_TYPES}: what a stored row may say. */
export type LedgerRefType = (typeof LEDGER_REF_TYPES)[number];

/**
 * The `ref_type` words a new ledger transaction may write (`ledger_transactions_ref_type_current_check`, added NOT VALID).
 *
 * Why: decision 064: the pointer to a buyer is `account`, never the old `client` or `customer`.
 */
export const CURRENT_LEDGER_REF_TYPES = [
  'order',
  'payment',
  'invoice',
  'refund',
  'dispute',
  'accrual',
  'supplier',
  'system',
  'account',
] as const;

/** One value of {@link CURRENT_LEDGER_REF_TYPES}: what a writer may pass. */
export type CurrentLedgerRefType = (typeof CURRENT_LEDGER_REF_TYPES)[number];

/**
 * Every word `ledger_transactions.created_by_type` may hold, the old ones included: who posted a ledger transaction.
 *
 * Why: the console's ledger wire enum (GET /admin/ledger/transactions). Append-only, like {@link LEDGER_REF_TYPES}: old rows keep
 * `client` and `customer`; new rows may write {@link CURRENT_LEDGER_ACTOR_TYPES} only.
 */
export const LEDGER_ACTOR_TYPES = ['staff', 'client', 'customer', 'system', 'account'] as const;

/** One value of {@link LEDGER_ACTOR_TYPES}: what a stored row may say. */
export type LedgerActorType = (typeof LEDGER_ACTOR_TYPES)[number];

/**
 * The `created_by_type` words a new ledger transaction may write (`ledger_transactions_created_by_type_current_check`, added NOT VALID).
 *
 * Why: decision 064: an account is one word.
 */
export const CURRENT_LEDGER_ACTOR_TYPES = ['staff', 'account', 'system'] as const;

/** One value of {@link CURRENT_LEDGER_ACTOR_TYPES}: what a writer may pass. */
export type CurrentLedgerActorType = (typeof CURRENT_LEDGER_ACTOR_TYPES)[number];

/**
 * The two wallet kinds an invoice can top up (or, for a manual invoice, settle): the merchant wallet and the retail store balance.
 *
 * Why: decision 064: an invoice carries the wallet kind of its account's rank when it was made, so a later rank change never
 * re-reads old invoices as the other kind.
 */
export const INVOICE_WALLET_KINDS = ['client_wallet', 'customer_wallet'] as const;

/** One value of {@link INVOICE_WALLET_KINDS}. */
export type InvoiceWalletKind = (typeof INVOICE_WALLET_KINDS)[number];

/**
 * The two kinds of rank, as the rank history stores them: `retail` (any rank that is not a merchant rank) and `merchant`.
 *
 * Why: decision 064: the rank-change history keeps the kind of both ranks as they were, so it stays true after a rank is renamed or deleted.
 */
export const RANK_KINDS = ['retail', 'merchant'] as const;

/** One value of {@link RANK_KINDS}: a rank kind as the history stores it (the identity module's `RankKind` has the same two words). */
export type StoredRankKind = (typeof RANK_KINDS)[number];

/**
 * What a staff wallet action does: freeze the wallet, unfreeze it, or set the credit limit.
 *
 * Why: decision 064: these three actions carry an `Idempotency-Key` stored in `wallet_action_keys`.
 */
export const WALLET_ACTIONS = ['freeze', 'unfreeze', 'credit_limit'] as const;

/** One value of {@link WALLET_ACTIONS}. */
export type WalletAction = (typeof WALLET_ACTIONS)[number];

/**
 * Invoice kinds: wallet top-up, manual, B2C tax receipt and statement.
 *
 * Why: the console's invoice wire enum (GET /admin/invoices).
 *
 * `statement` is retired (decision 062): nothing ever created one and no filter offers it (`INVOICE_FILTER_KINDS` of the invoice rules); the
 * value stays here because the check constraint and the readers must accept an old row.
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
 * The keys of the ready-made payment methods (the catalog in `domain/gateway-presets.ts`).
 *
 * Why: feature 32 (decision 041, B232): a method made from the catalog remembers its preset, which names the logo each frontend
 * ships. The list is closed by `payment_gateways_preset_check`; a new preset needs a migration.
 */
export const GATEWAY_PRESET_KEYS = [
  'bank_transfer',
  'crypto_transfer',
  'vodafone_cash',
  'fawry_transfer',
  'instapay',
  'binance_pay',
  'nowpayments',
  'binance_pay_auto',
] as const;

/** One value of {@link GATEWAY_PRESET_KEYS}. */
export type GatewayPresetKey = (typeof GATEWAY_PRESET_KEYS)[number];

/**
 * What a payment pays for: a wallet top-up or a B2C order.
 *
 * Why: the console's payment wire enum (GET /admin/payments).
 */
export const PAYMENT_PURPOSES = ['topup', 'order'] as const;

/** One value of {@link PAYMENT_PURPOSES}. */
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

/**
 * States of a wallet top-up payment: staff approve or reject it.
 *
 * Why: RESOLUTIONS money-2: `/admin/payments` serves top-ups only, and their wire enum is pending, approved, rejected.
 */
export const TOPUP_PAYMENT_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** One value of {@link TOPUP_PAYMENT_STATUSES}. */
export type TopupPaymentStatus = (typeof TOPUP_PAYMENT_STATUSES)[number];

/**
 * States of a B2C order payment, as the gateway reports them.
 *
 * Why: RESOLUTIONS money-2 and scenarios b2c-paid, b2c-refund and b2c-chargeback.
 */
export const ORDER_PAYMENT_STATUSES = [
  'pending',
  'captured',
  'failed',
  'refunded',
  'partial_refund',
  'disputed',
  'chargeback',
] as const;

/** One value of {@link ORDER_PAYMENT_STATUSES}. */
export type OrderPaymentStatus = (typeof ORDER_PAYMENT_STATUSES)[number];

/**
 * How a merchant pays a top-up: bank transfer, card, USDT or Wise.
 *
 * Why: RESOLUTIONS money-2 and b2c-6: the money.md wire enum of top-ups.
 */
export const TOPUP_METHODS = ['bank', 'card', 'usdt', 'wise'] as const;

/** One value of {@link TOPUP_METHODS}. */
export type TopupMethod = (typeof TOPUP_METHODS)[number];

/**
 * How a storefront customer pays an order: card, wallet (Apple Pay, PayPal, ...), crypto (any coin), or the customer's own store
 * balance (`balance`: no gateway).
 *
 * Why: RESOLUTIONS money-2 and b2c-6: B2C gateway drivers store only the first three; feature 21 adds `balance`, the one method
 * whose payment has no gateway (`payments_gateway_check`).
 */
export const ORDER_METHODS = ['card', 'wallet', 'crypto', 'balance'] as const;

/** One value of {@link ORDER_METHODS}. */
export type OrderMethod = (typeof ORDER_METHODS)[number];

/**
 * How a refund is paid back: to the original payment method or by hand.
 *
 * Why: RESOLUTIONS money-12: the console's refund wire enum (B81 settled).
 */
export const REFUND_METHODS = ['original', 'manual'] as const;

/** One value of {@link REFUND_METHODS}. */
export type RefundMethod = (typeof REFUND_METHODS)[number];

/**
 * Refund states; `processing` is sent as is (B82 resolved, console M258): the gateway call is in flight.
 *
 * Why: the console's refund wire enum plus `processing` of MISMATCHES B82.
 */
export const REFUND_STATUSES = ['requested', 'processing', 'completed', 'failed', 'rejected'] as const;

/** One value of {@link REFUND_STATUSES}. */
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/**
 * Who asked for a refund: a staff member, an account or the system.
 *
 * Why: the console's refund wire enum; decision 064 rewrote the word `customer` to `account` (refund rows are mutable).
 */
export const REFUND_REQUESTER_TYPES = ['staff', 'account', 'system'] as const;

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
    /** when a refresh held the provider's rate because it moved more than `fx.max_refresh_move_percent` from this one; null while not held (decision 049) */
    rateHeldAt: timestampTz(),
    markupPercent: percent().notNull().default('0'),
    charmRounding: boolean().notNull().default(false),
    isStorefront: boolean().notNull().default(false),
    /** fraction digits shown for the currency (0 to 4, RESOLUTIONS money-13) */
    decimals: integer().notNull().default(2),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('currencies_code_uq').on(t.code),
    check('currencies_rate_check', sql`${t.rateToBase} > 0`),
    check('currencies_decimals_check', sql`${t.decimals} between 0 and 4`),
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
    /** polymorphic: clients (an account id) or suppliers by owner_type; null for system accounts */
    ownerId: bigId(),
    currency: text()
      .references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' })
      .notNull(),
    /** kept in the account's normal sign (decision 024) */
    balance: money().notNull().default('0'),
    /** merchant credit limit on client_wallet accounts; zero on every other kind (`ledger_accounts_overdraft_kind_check`) */
    overdraftLimit: money().notNull().default('0'),
    /** when a wallet (a `customer_wallet` or a `client_wallet`) was put on hold (staff or a top-up dispute); null when not frozen, always null on other kinds (feature 21, decision 064) */
    frozenAt: timestampTz(),
    /** why the wallet is on hold (staff note or the dispute); empty when not frozen (feature 21) */
    frozenReason: text().notNull().default(''),
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
      sql`(${t.kind} in ('client_wallet', 'client_hold', 'customer_wallet') and ${t.ownerType} is not distinct from 'account')
 or (${t.kind} = 'supplier_prepaid' and ${t.ownerType} is not distinct from 'supplier')
 or (${t.kind} not in ('client_wallet', 'client_hold', 'supplier_prepaid', 'customer_wallet') and ${t.ownerType} is null)`,
    ),
    check('ledger_accounts_overdraft_check', sql`${t.overdraftLimit} >= 0`),
    index('ledger_accounts_currency_idx').on(t.currency),
    // Feature 21, widened by decision 064: only a wallet (of either kind) can be frozen; only a merchant wallet has a credit limit.
    check(
      'ledger_accounts_frozen_check',
      sql`${t.frozenAt} is null or ${t.kind} in ('customer_wallet', 'client_wallet')`,
    ),
    check('ledger_accounts_overdraft_kind_check', sql`${t.overdraftLimit} = 0 or ${t.kind} = 'client_wallet'`),
    index('ledger_accounts_customer_wallet_idx')
      .on(t.balance)
      .where(sql`${t.kind} = 'customer_wallet'`),
    index('ledger_accounts_frozen_idx')
      .on(t.frozenAt)
      .where(sql`${t.frozenAt} is not null`),
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
    /** polymorphic by ref_type; 0 for system postings (RESOLUTIONS money-6), never null */
    refId: bigId().notNull().default(0),
    memo: text().notNull().default(''),
    idempotencyKey: text().notNull(),
    createdByType: text().$type<LedgerActorType>().notNull(),
    /** staff_users or clients (an account id) by created_by_type; a `client` or `customer` row of before decision 064 is read through `account_legacy_ids`; null when the system posted */
    createdById: bigId(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('ledger_transactions_idempotency_key_uq').on(t.idempotencyKey),
    check('ledger_transactions_ref_type_check', inList(t.refType, LEDGER_REF_TYPES)),
    check('ledger_transactions_created_by_type_check', inList(t.createdByType, LEDGER_ACTOR_TYPES)),
    // Added NOT VALID by the expand migration: the rows of before stay, a new row writes the current words only.
    check('ledger_transactions_ref_type_current_check', inList(t.refType, CURRENT_LEDGER_REF_TYPES)),
    check('ledger_transactions_created_by_type_current_check', inList(t.createdByType, CURRENT_LEDGER_ACTOR_TYPES)),
    index('ledger_transactions_ref_idx').on(t.refType, t.refId),
    index('ledger_transactions_kind_idx').on(t.kind, t.createdAt.desc()),
    index('ledger_transactions_created_idx').on(t.createdAt.desc()),
    check('ledger_transactions_actor_check', sql`(${t.createdByType} = 'system') = (${t.createdById} is null)`),
    check('ledger_transactions_ref_id_check', sql`${t.refId} > 0 or ${t.refType} = 'system'`),
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
 * Why: Wallet top-up invoices, statements and B2C tax receipts (routes /admin/invoices, /client/invoices). Decision 064: every
 * invoice belongs to an account (`account_id`), and a top-up or manual invoice also says which wallet kind it fills (`wallet_kind`).
 */
export const invoices = pgTable(
  'invoices',
  {
    id: pk(),
    number: text().notNull(),
    /** the account the invoice is for (any rank) */
    accountId: fk((): AnyPgColumn => clients.id).notNull(),
    /**
     * the wallet a top-up or manual invoice fills, fixed when it was made (`client_wallet` or `customer_wallet`); null for a receipt or
     * a statement
     */
    walletKind: text().$type<InvoiceWalletKind>(),
    /**
     * the merchant of a merchant invoice (the same value as `account_id`): written during the expand release for the readers of the old
     * image, never read (the SQL column is `client_id`); the contract migration drops it
     */
    legacyClientId: bigint('client_id', { mode: 'number' }).references((): AnyPgColumn => clients.id, {
      onDelete: 'restrict',
    }),
    /** the old customer id: retired (decision 064), unread and unwritten (the SQL column is `customer_id`); the contract migration drops it */
    retiredCustomerId: bigint('customer_id', { mode: 'number' }).references((): AnyPgColumn => retiredCustomers.id, {
      onDelete: 'restrict',
    }),
    orderId: fk((): AnyPgColumn => orders.id),
    kind: text().$type<InvoiceKind>().notNull(),
    amount: money().notNull(),
    fee: money().notNull().default('0'),
    /** amount minus fee; the service sets it (RESOLUTIONS money-7) */
    netAmount: money().notNull(),
    taxAmount: money().notNull().default('0'),
    taxRate: percent().notNull().default('0'),
    /** ISO country of the tax; empty when no tax applies */
    taxCountry: text().notNull().default(''),
    /** the buyer's VAT number (text, not a database id); empty when none */
    customerVatId: text().notNull().default(''),
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
    /** where the merchant pays an open top-up invoice of an automatic gateway (the hosted checkout); null otherwise (feature 8, B163) */
    checkoutUrl: text(),
    /** the account's `Idempotency-Key` of a top-up: a retry with it finds the invoice (feature 21, decision 064); null otherwise */
    idempotencyKey: text(),
    /** what that top-up asked for (gateway and amount): the same key with another request is refused (feature 21) */
    requestFingerprint: text(),
    /** the staff member who issued a manual invoice (decision 049); null for the other kinds and for invoices issued before it */
    issuedBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('invoices_number_uq').on(t.number),
    uniqueIndex('invoices_customer_key_uq')
      .on(t.retiredCustomerId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    uniqueIndex('invoices_account_key_uq')
      .on(t.accountId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    check('invoices_kind_check', inList(t.kind, INVOICE_KINDS)),
    check('invoices_status_check', inList(t.status, INVOICE_STATUSES)),
    // A top-up or manual invoice names its wallet kind, every other kind has none, and a manual invoice is always a merchant one.
    check(
      'invoices_wallet_kind_check',
      sql`(${t.walletKind} is null or ${inList(t.walletKind, INVOICE_WALLET_KINDS)})
 and ((${t.kind} in ('topup', 'manual')) = (${t.walletKind} is not null))
 and (${t.kind} <> 'manual' or ${t.walletKind} = 'client_wallet')`,
    ),
    // While the old column lasts it repeats the account.
    check('invoices_client_account_check', sql`${t.legacyClientId} is null or ${t.legacyClientId} = ${t.accountId}`),
    index('invoices_client_created_idx').on(t.legacyClientId, t.createdAt.desc()),
    index('invoices_account_created_idx').on(t.accountId, t.createdAt.desc()),
    index('invoices_status_created_idx').on(t.status, t.createdAt.desc()),
    index('invoices_created_idx').on(t.createdAt.desc()),
    check('invoices_amount_check', sql`${t.amount} >= 0 and ${t.fee} >= 0`),
    index('invoices_customer_id_idx').on(t.retiredCustomerId),
    index('invoices_order_id_idx').on(t.orderId),
    index('invoices_currency_idx').on(t.currency),
    index('invoices_gateway_id_idx').on(t.gatewayId),
    index('invoices_pdf_file_id_idx').on(t.pdfFileId),
    index('invoices_issued_by_idx').on(t.issuedBy),
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
    /** the catalog entry the method was made from (feature 32); null for a custom method; never changes */
    preset: text().$type<GatewayPresetKey>(),
    /** the logo staff uploaded (a public picture under `media/`, feature 32); null for none; it wins over the preset's logo */
    logoFileId: bigId().references((): AnyPgColumn => files.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('payment_gateways_code_uq').on(t.code),
    index('payment_gateways_logo_file_id_idx').on(t.logoFileId),
    check('payment_gateways_audience_check', inList(t.audience, GATEWAY_AUDIENCES)),
    check('payment_gateways_preset_check', sql`${t.preset} is null or ${inList(t.preset, GATEWAY_PRESET_KEYS)}`),
    check('payment_gateways_fee_check', sql`${t.feePercent} between 0 and 100 and ${t.feeFixed} >= 0`),
    check('payment_gateways_limits_check', sql`${t.minAmount} >= 0 and ${t.maxAmount} >= 0`),
  ],
);

/** A row read from `payment_gateways`. */
export type PaymentGateway = typeof paymentGateways.$inferSelect;

/** A row to insert into `payment_gateways`. */
export type NewPaymentGateway = typeof paymentGateways.$inferInsert;

/**
 * The partial unique index that lets one receipt file back at most one pending or approved payment.
 *
 * Why: decision 049: the receipt routes tell this unique violation apart from the bank reference's.
 */
export const RECEIPT_LIVE_INDEX = 'payments_receipt_live_uq';

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
    /** the account that pays: the owner of the invoice for a top-up, the buyer of the order for an order payment (decision 064) */
    accountId: fk((): AnyPgColumn => clients.id).notNull(),
    /** the old customer id: retired (decision 064), unread and unwritten (the SQL column is `customer_id`); the contract migration drops it */
    retiredCustomerId: bigint('customer_id', { mode: 'number' }).references((): AnyPgColumn => retiredCustomers.id, {
      onDelete: 'restrict',
    }),
    orderId: fk((): AnyPgColumn => orders.id),
    purpose: text().$type<PaymentPurpose>().notNull(),
    /** null only for a payment from the customer's store balance (`method_type 'balance'`, feature 21) */
    gatewayId: fk((): AnyPgColumn => paymentGateways.id),
    /** the gateway's reference, kept as text; unique per gateway */
    gatewayTxnId: text(),
    amount: money().notNull(),
    feeAmount: money().notNull().default('0'),
    currency: text()
      .references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' })
      .notNull(),
    /** a top-up has {@link TOPUP_PAYMENT_STATUSES}, an order payment {@link ORDER_PAYMENT_STATUSES} (RESOLUTIONS money-2) */
    status: text().$type<TopupPaymentStatus | OrderPaymentStatus>().notNull(),
    /** a top-up has {@link TOPUP_METHODS}, an order payment {@link ORDER_METHODS} (RESOLUTIONS money-2, b2c-6) */
    methodType: text().$type<TopupMethod | OrderMethod>().notNull(),
    /** card brand or wallet name for display (visa, apple_pay, ...); empty when unknown (RESOLUTIONS money-4) */
    brand: text().notNull().default(''),
    /** the gateway's card fingerprint for the blocklist, never card data (RESOLUTIONS b2c-5) */
    cardFingerprint: text(),
    /** true when risk flagged the payment, so it waits for staff instead of crediting itself (RESOLUTIONS money-3) */
    reviewRequired: boolean().notNull().default(false),
    /** when an automatic gateway's confirmed top-up credits itself; null when it waits for staff (money-3) */
    autoCreditAt: timestampTz(),
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
    /** the storefront checkout this order payment pays; null for a top-up (feature 16) */
    checkoutSessionId: fk((): AnyPgColumn => checkoutSessions.id),
    /** the `Idempotency-Key` of the `/pay` call that opened this payment: a retry with it finds the payment (feature 16) */
    idempotencyKey: text(),
    /** where the customer pays: the hosted page the gateway opened for a pending order payment; null otherwise (feature 16) */
    checkoutUrl: text(),
    /** what the `/pay` call asked for (gateway and return address), kept apart from `raw` so capture and failure never overwrite it: the same key with another request is refused (feature 16) */
    requestFingerprint: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A gateway's own reference names one payment for good (a repeated confirmation creates none); a bank reference typed on a receipt is
    // held only by a pending or approved payment, so a rejected claim releases it (stored in one form, `normalizeBankReference`).
    uniqueIndex('payments_gateway_txn_uq')
      .on(t.gatewayId, t.gatewayTxnId)
      .where(
        sql`${t.gatewayTxnId} is not null and (${t.receiptFileId} is null or ${inList(t.status, ['pending', 'approved'])})`,
      ),
    check('payments_purpose_check', inList(t.purpose, PAYMENT_PURPOSES)),
    // One vocabulary per purpose (RESOLUTIONS money-2); the union also covers b2c-6 (method_type in the six values).
    check(
      'payments_status_check',
      sql`(${t.purpose} = 'topup' and ${inList(t.status, TOPUP_PAYMENT_STATUSES)})
 or (${t.purpose} = 'order' and ${inList(t.status, ORDER_PAYMENT_STATUSES)})`,
    ),
    check(
      'payments_method_type_check',
      sql`(${t.purpose} = 'topup' and ${inList(t.methodType, TOPUP_METHODS)})
 or (${t.purpose} = 'order' and ${inList(t.methodType, ORDER_METHODS)})`,
    ),
    index('payments_purpose_status_created_idx').on(t.purpose, t.status, t.createdAt.desc()),
    index('payments_customer_id_idx').on(t.retiredCustomerId),
    index('payments_account_id_idx').on(t.accountId),
    check('payments_amount_check', sql`${t.amount} > 0 and ${t.feeAmount} >= 0`),
    index('payments_invoice_id_idx').on(t.invoiceId),
    index('payments_order_id_idx').on(t.orderId),
    index('payments_gateway_id_idx').on(t.gatewayId),
    index('payments_currency_idx').on(t.currency),
    index('payments_receipt_file_id_idx').on(t.receiptFileId),
    // Decision 049: one receipt file backs one live payment; a rejected payment releases its file.
    uniqueIndex(RECEIPT_LIVE_INDEX)
      .on(t.receiptFileId)
      .where(sql`${t.receiptFileId} is not null and ${inList(t.status, ['pending', 'approved'])}`),
    index('payments_reviewed_by_idx').on(t.reviewedBy),
    index('payments_auto_credit_idx')
      .on(t.autoCreditAt)
      .where(sql`${t.status} = 'pending' and ${t.autoCreditAt} is not null`),
    index('payments_card_fingerprint_idx')
      .on(t.cardFingerprint)
      .where(sql`${t.cardFingerprint} is not null`),
    index('payments_checkout_session_id_idx').on(t.checkoutSessionId),
    uniqueIndex('payments_session_key_uq')
      .on(t.checkoutSessionId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
    // Feature 21: a balance payment has no gateway, every other payment has one; one balance payment per checkout.
    check('payments_gateway_check', sql`(${t.methodType} = 'balance') = (${t.gatewayId} is null)`),
    uniqueIndex('payments_balance_session_uq')
      .on(t.checkoutSessionId)
      .where(sql`${t.methodType} = 'balance'`),
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
 *
 * Retired (decision 062): unread and unwritten, no code names it; the accounts migration drops it.
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
    /**
     * the account the refund goes back to: the account of its payment (an orderless return of a held payment included); null only for
     * a refund without a payment (the retired merchant rows). Written by every refund writer with the account of the payment.
     */
    accountId: fk((): AnyPgColumn => clients.id),
    /** the old customer id: retired (decision 064), unread and unwritten (the SQL column is `customer_id`); the contract migration drops it */
    retiredCustomerId: bigint('customer_id', { mode: 'number' }).references((): AnyPgColumn => retiredCustomers.id, {
      onDelete: 'restrict',
    }),
    /** Retired (decision 062): nothing ever wrote it and nothing reads it (the SQL column is `client_id`); the contract migration drops it. */
    retiredClientId: bigint('client_id', { mode: 'number' }).references((): AnyPgColumn => clients.id, {
      onDelete: 'restrict',
    }),
    amount: money().notNull(),
    currency: text()
      .references((): AnyPgColumn => currencies.code, { onDelete: 'restrict' })
      .notNull(),
    reason: text().notNull().default(''),
    /** the map says card, wallet or store credit while the wire says original or manual (B81, RESOLUTIONS money-12) */
    method: text().$type<RefundMethod>().notNull(),
    status: text().$type<RefundStatus>().notNull().default('requested'),
    /** the gateway's reference, kept as text */
    gatewayRefundId: text(),
    requestedByType: text().$type<RefundRequesterType>().notNull(),
    /** clients (an account id) or staff_users by requested_by_type; null for the system */
    requestedById: bigId(),
    approvedBy: fk((): AnyPgColumn => staffUsers.id),
    ledgerTxId: fk((): AnyPgColumn => ledgerTransactions.id),
    completedAt: timestampTz(),
    /** schema addition B116 */
    note: text().notNull().default(''),
    /**
     * Schema addition (feature 16): which gateway idempotency key the next send uses. 1 is `refund-<id>`, n is `refund-<id>-<n>`. It grows when
     * the gateway refused the refund for good (a 4xx answer, a failed refund object), because the same key would only replay that refusal;
     * it stays when the answer is unknown (a timeout, a 5xx), because the gateway may have made the refund and the same key stops a second one.
     */
    sendAttempt: integer().notNull().default(1),
    /**
     * Schema addition: the start of the first send under the current idempotency key that got no answer from the gateway (a timeout, a 5xx, a
     * network error, a send job that was lost); null when every send under the key was answered or none was made. Cleared when the key moves
     * on. The gateway may have made such a refund and keeps a key 24 hours, so 20 hours after this the refund is not sent under the key again.
     */
    unansweredSendAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('refunds_send_attempt_check', sql`${t.sendAttempt} >= 1`),
    check('refunds_status_check', inList(t.status, REFUND_STATUSES)),
    check('refunds_method_check', inList(t.method, REFUND_METHODS)),
    // A refund names an account exactly when it names a payment; whether it names an order is `order_id` alone (an orderless return of a
    // held payment has a payment and an account but no order).
    check('refunds_account_refs_check', sql`(${t.paymentId} is null) = (${t.accountId} is null)`),
    check('refunds_requested_by_type_check', inList(t.requestedByType, REFUND_REQUESTER_TYPES)),
    index('refunds_status_created_idx').on(t.status, t.createdAt.desc()),
    index('refunds_created_idx').on(t.createdAt.desc()),
    check('refunds_amount_check', sql`${t.amount} > 0`),
    check('refunds_requester_check', sql`(${t.requestedByType} = 'system') = (${t.requestedById} is null)`),
    index('refunds_payment_id_idx').on(t.paymentId),
    index('refunds_order_id_idx').on(t.orderId),
    index('refunds_customer_id_idx').on(t.retiredCustomerId),
    index('refunds_client_id_idx').on(t.retiredClientId),
    index('refunds_account_id_idx').on(t.accountId),
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
    /** the account of the disputed payment */
    accountId: fk((): AnyPgColumn => clients.id).notNull(),
    /** the old customer id: retired (decision 064), unread and unwritten (the SQL column is `customer_id`); the contract migration drops it */
    retiredCustomerId: bigint('customer_id', { mode: 'number' }).references((): AnyPgColumn => retiredCustomers.id, {
      onDelete: 'restrict',
    }),
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
    index('disputes_customer_id_idx').on(t.retiredCustomerId),
    index('disputes_account_id_idx').on(t.accountId),
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

/**
 * The raises of merchant credit limits that staff made: one row per raise, holding the part by which the new limit exceeds the one it
 * replaced (the whole limit for a new merchant).
 *
 * Why: decision 049: a credit limit is money the merchant can spend, so what one staff member raises within 24 hours counts in the same
 * sum as their credit adjustments against `wallet.adjust_approval_limit`. A lowering, or a limit sent unchanged, adds no row. Rows are
 * only inserted (by the credit-limit route and the merchant invitation) and read only for that sum.
 */
export const creditLimitRaises = pgTable(
  'credit_limit_raises',
  {
    id: pk(),
    clientId: fk((): AnyPgColumn => clients.id).notNull(),
    staffId: fk((): AnyPgColumn => staffUsers.id).notNull(),
    /** the new limit minus the limit it replaced; always above zero */
    amount: money().notNull(),
    /** written from the clock, as the 24-hour window is measured on it */
    createdAt: createdAt(),
  },
  (t) => [
    check('credit_limit_raises_amount_check', sql`${t.amount} > 0`),
    index('credit_limit_raises_staff_created_idx').on(t.staffId, t.createdAt.desc()),
    index('credit_limit_raises_client_id_idx').on(t.clientId),
  ],
);

/** A row read from `credit_limit_raises`. */
export type CreditLimitRaise = typeof creditLimitRaises.$inferSelect;

/**
 * The history of rank changes: one row per change of an account's rank, with the money that moved when the change crossed from one wallet
 * kind to the other.
 *
 * Why: decision 064: a rank change is one staff action (`POST /admin/clients/:id/rank`, Owner only, with an `Idempotency-Key`) that also
 * ends sessions, revokes API keys and, across kinds, moves the balance in one ledger transaction. This row is its record, and the key makes
 * a retry change nothing. The two rank ids carry no foreign key on purpose: the row keeps its meaning after a rank is renamed or deleted,
 * so it also stores the name and kind of both ranks as they were.
 *
 * Append-only: a trigger rejects UPDATE and DELETE (the expand migration), the table has no `updated_at`, and the application role gets
 * no UPDATE or DELETE on it (`APPEND_ONLY_TABLES`).
 */
export const accountRankChanges = pgTable(
  'account_rank_changes',
  {
    id: pk(),
    accountId: fk((): AnyPgColumn => clients.id).notNull(),
    /** client_groups.id before the change; no foreign key (see the table) */
    fromGroupId: bigId().notNull(),
    /** the name of that rank at the time of the change */
    fromGroupName: text().notNull(),
    /** client_groups.id after the change; no foreign key (see the table) */
    toGroupId: bigId().notNull(),
    /** the name of that rank at the time of the change */
    toGroupName: text().notNull(),
    /** the kind of the old rank: `retail` or `merchant` (the stored kind `b2b` is `merchant`) */
    fromKind: text().$type<StoredRankKind>().notNull(),
    /** the kind of the new rank */
    toKind: text().$type<StoredRankKind>().notNull(),
    /** the balance moved to the other wallet kind; zero when the kind stayed the same or the wallet was empty */
    movedAmount: money().notNull().default('0'),
    /** the posting that moved the balance; null exactly when nothing moved */
    ledgerTransactionId: fk((): AnyPgColumn => ledgerTransactions.id),
    /** the `Idempotency-Key` header of the request: unique for the account */
    idempotencyKey: text().notNull(),
    sessionsEnded: integer().notNull().default(0),
    apiKeysRevoked: integer().notNull().default(0),
    staffId: fk((): AnyPgColumn => staffUsers.id).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'account_rank_changes_kind_check',
      sql`${inList(t.fromKind, RANK_KINDS)} and ${inList(t.toKind, RANK_KINDS)}`,
    ),
    check('account_rank_changes_groups_check', sql`${t.fromGroupId} <> ${t.toGroupId}`),
    // Money only moves when the kind changes.
    check(
      'account_rank_changes_amount_check',
      sql`${t.movedAmount} >= 0 and (${t.fromKind} <> ${t.toKind} or ${t.movedAmount} = 0)`,
    ),
    check('account_rank_changes_transaction_check', sql`(${t.movedAmount} = 0) = (${t.ledgerTransactionId} is null)`),
    unique('account_rank_changes_key_uq').on(t.accountId, t.idempotencyKey),
    index('account_rank_changes_account_idx').on(t.accountId, t.createdAt.desc()),
    index('account_rank_changes_ledger_transaction_id_idx').on(t.ledgerTransactionId),
    index('account_rank_changes_staff_id_idx').on(t.staffId),
  ],
);

/** A row read from `account_rank_changes`. */
export type AccountRankChange = typeof accountRankChanges.$inferSelect;

/** A row to insert into `account_rank_changes`. */
export type NewAccountRankChange = typeof accountRankChanges.$inferInsert;

/**
 * The `Idempotency-Key` of a staff freeze, unfreeze or credit-limit change, with the first answer.
 *
 * Why: decision 064: these wallet actions are retried by the console. A request whose key is already stored for the account replays the
 * stored `response` when the action and the request hash match and is refused otherwise; it never applies the change again, so a retried
 * freeze that arrives after a later unfreeze changes nothing. The row is written in the transaction of the change and kept (staff actions
 * are rare and the row is part of the account's history). It is not the order portal's `idempotency_keys` table, which is per merchant and
 * purged after seven days.
 *
 * Append-only: a trigger rejects UPDATE and DELETE (the expand migration), the table has no `updated_at`, and the application role gets
 * no UPDATE or DELETE on it (`APPEND_ONLY_TABLES`).
 */
export const walletActionKeys = pgTable(
  'wallet_action_keys',
  {
    id: pk(),
    accountId: fk((): AnyPgColumn => clients.id).notNull(),
    action: text().$type<WalletAction>().notNull(),
    /** the header as sent (1 to 100 printable characters) */
    idempotencyKey: text().notNull(),
    /** keyed hash of the action and the validated body: the same key with another request is refused */
    requestHash: text().notNull(),
    /** the first answer (the account wallet view), replayed */
    response: jsonb().$type<Record<string, unknown>>().notNull(),
    staffId: fk((): AnyPgColumn => staffUsers.id).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('wallet_action_keys_action_check', inList(t.action, WALLET_ACTIONS)),
    unique('wallet_action_keys_key_uq').on(t.accountId, t.idempotencyKey),
    index('wallet_action_keys_staff_idx').on(t.staffId),
  ],
);

/** A row read from `wallet_action_keys`. */
export type WalletActionKey = typeof walletActionKeys.$inferSelect;

/** A row to insert into `wallet_action_keys`. */
export type NewWalletActionKey = typeof walletActionKeys.$inferInsert;
