// Commissions tables (map domain F): referral and rebate plans, who benefits, and what is owed.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  createdAt,
  fk,
  inList,
  jsonObject,
  money,
  percent,
  pk,
  timestampTz,
  updatedAt,
} from '../../../infra/db/columns';
import { clients } from '../../identity/db/schema';
import { ledgerTransactions } from '../../money/db/schema';
import { orders } from '../../orders/db/schema';

/**
 * Kinds of commission plan: a referral reward or a rebate (cashback).
 *
 * Why: the console's plan wire enum (GET /admin/commission-plans).
 */
export const COMMISSION_PLAN_KINDS = ['referral', 'rebate'] as const;

/** One value of {@link COMMISSION_PLAN_KINDS}. */
export type CommissionPlanKind = (typeof COMMISSION_PLAN_KINDS)[number];

/**
 * Life of a commission accrual: `accrued` when the order completes, `approved` by staff (the commission money event),
 * `reversed` when the order is refunded.
 *
 * Why: RESOLUTIONS health-commissions-11 and the console's accrual wire enum (GET /admin/commission-accruals).
 */
export const COMMISSION_ACCRUAL_STATUSES = ['accrued', 'approved', 'reversed'] as const;

/** One value of {@link COMMISSION_ACCRUAL_STATUSES}. */
export type CommissionAccrualStatus = (typeof COMMISSION_ACCRUAL_STATUSES)[number];

/**
 * Referral and cashback plans.
 *
 * Why: Referral and cashback plans a merchant can be assigned to (routes /admin/commission-plans).
 */
export const commissionPlans = pgTable(
  'commission_plans',
  {
    id: pk(),
    name: text().notNull(),
    kind: text().$type<CommissionPlanKind>().notNull(),
    /** what the percentage applies to (revenue, profit, ...); no source fixes the values */
    basis: text().notNull(),
    percent: percent().notNull().default('0'),
    /** the volume tiers as an object (for example `{ brackets: [...] }`); `{}` for a flat plan (RESOLUTIONS health-commissions-1) */
    tiers: jsonObject(),
    /** accrual period (monthly, ...); no source fixes the values */
    period: text().notNull(),
    isActive: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('commission_plans_kind_check', inList(t.kind, COMMISSION_PLAN_KINDS)),
    check('commission_plans_percent_check', sql`${t.percent} between 0 and 100`),
    check('commission_plans_tiers_check', sql`jsonb_typeof(${t.tiers}) = 'object'`),
  ],
);

/** A row read from `commission_plans`. */
export type CommissionPlan = typeof commissionPlans.$inferSelect;

/** A row to insert into `commission_plans`. */
export type NewCommissionPlan = typeof commissionPlans.$inferInsert;

/**
 * Links a plan to the merchant who benefits from it.
 *
 * Why: Links a plan to the merchant who benefits; ending an assignment sets ends_at (B42, routes
 * /admin/commission-assignments).
 */
export const commissionAssignments = pgTable(
  'commission_assignments',
  {
    id: pk(),
    planId: fk((): AnyPgColumn => commissionPlans.id).notNull(),
    beneficiaryId: fk((): AnyPgColumn => clients.id).notNull(),
    /** what the plan covers for this merchant; no source fixes the values */
    scope: text().notNull(),
    startsAt: timestampTz().notNull().defaultNow(),
    endsAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // A merchant has one current plan at a time (RESOLUTIONS health-commissions-2).
    uniqueIndex('commission_assignments_current_uq')
      .on(t.beneficiaryId)
      .where(sql`${t.endsAt} is null`),
    index('commission_assignments_beneficiary_id_idx').on(t.beneficiaryId),
    index('commission_assignments_plan_id_idx').on(t.planId),
  ],
);

/** A row read from `commission_assignments`. */
export type CommissionAssignment = typeof commissionAssignments.$inferSelect;

/** A row to insert into `commission_assignments`. */
export type NewCommissionAssignment = typeof commissionAssignments.$inferInsert;

/**
 * Commissions owed and paid out.
 *
 * Why: Commissions owed, approved and paid out; approval posts the commission money event (B43, routes
 * /admin/commission-accruals).
 */
export const commissionAccruals = pgTable(
  'commission_accruals',
  {
    id: pk(),
    planId: fk((): AnyPgColumn => commissionPlans.id).notNull(),
    beneficiaryId: fk((): AnyPgColumn => clients.id).notNull(),
    /** every accrual comes from one completed order (RESOLUTIONS health-commissions-3) */
    orderId: fk((): AnyPgColumn => orders.id).notNull(),
    period: text().notNull(),
    basisAmount: money().notNull(),
    percent: percent().notNull(),
    amount: money().notNull(),
    status: text().$type<CommissionAccrualStatus>().notNull(),
    /** set exactly when the status is `approved` (RESOLUTIONS health-commissions-4) */
    approvedAt: timestampTz(),
    ledgerTxId: fk((): AnyPgColumn => ledgerTransactions.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('commission_accruals_beneficiary_status_idx').on(t.beneficiaryId, t.status),
    index('commission_accruals_status_created_idx').on(t.status, t.createdAt.desc()),
    index('commission_accruals_created_idx').on(t.createdAt.desc()),
    index('commission_accruals_plan_id_idx').on(t.planId),
    // The full order_id index stays: a partial one cannot serve the foreign key's restrict check.
    index('commission_accruals_order_id_idx').on(t.orderId),
    // A completed order accrues once per beneficiary; a reversed accrual does not block a re-completion.
    uniqueIndex('commission_accruals_order_beneficiary_uq')
      .on(t.orderId, t.beneficiaryId)
      .where(sql`${t.status} <> 'reversed'`),
    check('commission_accruals_status_check', inList(t.status, COMMISSION_ACCRUAL_STATUSES)),
    check('commission_accruals_approved_at_check', sql`(${t.status} = 'approved') = (${t.approvedAt} is not null)`),
    index('commission_accruals_approved_idx')
      .on(t.approvedAt.desc())
      .where(sql`${t.approvedAt} is not null`),
    index('commission_accruals_ledger_tx_id_idx').on(t.ledgerTxId),
  ],
);

/** A row read from `commission_accruals`. */
export type CommissionAccrual = typeof commissionAccruals.$inferSelect;

/** A row to insert into `commission_accruals`. */
export type NewCommissionAccrual = typeof commissionAccruals.$inferInsert;
