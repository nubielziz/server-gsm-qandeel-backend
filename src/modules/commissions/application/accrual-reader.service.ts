// AccrualReader: the reads of `/admin/commission-accruals` (stage 11) and of the merchant portal's `GET /client/commissions`: the accrual rows
// with the agent and the referred merchant named. The two lists share one query; they differ in what they show (RULES commissions 1,
// 2, resolutions health-commissions-3, -4 and -11, MISMATCHES B164).
import { Injectable } from '@nestjs/common';
import type { ParsedListQuery } from '../../../common/contract';
import { AppError } from '../../../common/errors';
import { DbService, type DbExecutor } from '../../../infra/db';
import type { CommissionAccrual, CommissionAccrualStatus } from '../db/schema';
import {
  type AccrualListField,
  type ClientAccrualListField,
  findAccrual,
  listAccrualRows,
} from '../infra/accrual.repository';
import { findMerchants, merchantsOfOrders } from '../infra/foreign-reads.repository';

/** An accrual as the console reads it (`CommissionAccrual`), with `approvedAt` and `reversedAt` as extra fields. */
export interface AccrualView {
  readonly id: number;
  readonly planId: number;
  readonly beneficiaryId: number;
  readonly orderId: number;
  readonly period: string;
  readonly basisAmount: string;
  readonly percent: string;
  readonly amount: string;
  readonly status: CommissionAccrualStatus;
  readonly ledgerTxId: number | null;
  /** When it was approved; `null` until then, and kept when an approved accrual is later paid back. */
  readonly approvedAt: string | null;
  /** When the order was refunded or reopened (a `reversed` accrual, or an `approved` one that was paid back); else `null`. */
  readonly reversedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** The agent that earns it. */
  readonly beneficiary: { readonly id: number; readonly name: string } | null;
  /** The order's merchant: the referred merchant, or the agent itself for a rebate. */
  readonly merchant: { readonly id: number; readonly name: string } | null;
}

/** An accrual as the merchant portal reads it: names and dates only, never the order, the plan or another merchant's id (B164). */
export interface ClientAccrualView {
  readonly id: number;
  readonly period: string;
  readonly merchant: { readonly name: string };
  readonly basisAmount: string;
  readonly percent: string;
  readonly amount: string;
  readonly status: CommissionAccrualStatus;
  readonly approvedAt: string | null;
  readonly createdAt: string;
}

/**
 * Reads accruals.
 *
 * Why: the console's accrual tab and the merchant's "my commissions" page. The agent and merchant names come from two batched
 * lookups (no N+1); the staff list cannot sort by name, and the merchant list only ever shows the signed-in merchant's rows.
 *
 * Side effects: none (reads only; never cached, an accrual's status decides what an approval pays).
 */
@Injectable()
export class AccrualReader {
  constructor(private readonly db: DbService) {}

  /**
   * Lists accruals for staff.
   *
   * @param query the parsed list request
   * @returns the page of accruals with the agent and the merchant, and the exact total
   */
  async list(query: ParsedListQuery<AccrualListField>): Promise<{ rows: AccrualView[]; total: number }> {
    const { rows, total } = await listAccrualRows(this.db.db, query);
    return { rows: await this.views(this.db.db, rows), total };
  }

  /**
   * Shows one accrual.
   *
   * @param id the accrual id
   * @returns the accrual
   * @throws {AppError} `NOT_FOUND`
   */
  async get(id: number): Promise<AccrualView> {
    const row = await findAccrual(this.db.db, id);
    if (!row) throw new AppError('NOT_FOUND', { detail: 'No commission accrual has this id.' });
    return (await this.views(this.db.db, [row]))[0]!;
  }

  /**
   * Lists a merchant's own accruals for the portal.
   *
   * @param clientId the signed-in merchant (the beneficiary)
   * @param query the parsed list request
   * @returns the page and the exact total
   */
  async listOwn(
    clientId: number,
    query: ParsedListQuery<ClientAccrualListField>,
  ): Promise<{ rows: ClientAccrualView[]; total: number }> {
    const { rows, total } = await listAccrualRows(this.db.db, query, clientId);
    const merchants = await merchantsOfOrders(
      this.db.db,
      rows.map((row) => row.orderId),
    );
    return {
      rows: rows.map((row) => ({
        id: row.id,
        period: row.period,
        merchant: { name: merchants.get(row.orderId)?.name ?? '' },
        basisAmount: row.basisAmount,
        percent: row.percent,
        amount: row.amount,
        status: row.status,
        approvedAt: row.approvedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
    };
  }

  /** Adds the agents' and the merchants' names to accrual rows with two batched queries. */
  private async views(db: DbExecutor, rows: readonly CommissionAccrual[]): Promise<AccrualView[]> {
    if (rows.length === 0) return [];
    const orders = await merchantsOfOrders(
      db,
      rows.map((row) => row.orderId),
    );
    const agents = await findMerchants(db, [...new Set(rows.map((row) => row.beneficiaryId))]);
    return rows.map((row) => {
      const agent = agents.get(row.beneficiaryId);
      return {
        id: row.id,
        planId: row.planId,
        beneficiaryId: row.beneficiaryId,
        orderId: row.orderId,
        period: row.period,
        basisAmount: row.basisAmount,
        percent: row.percent,
        amount: row.amount,
        status: row.status,
        ledgerTxId: row.ledgerTxId,
        approvedAt: row.approvedAt?.toISOString() ?? null,
        reversedAt: row.reversedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        beneficiary: agent ? { id: agent.id, name: agent.name } : null,
        merchant: orders.get(row.orderId) ?? null,
      };
    });
  }
}
