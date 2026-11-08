// RiskQueueService: GET /admin/risk/queue (map domain K, stage 18, RESOLUTIONS b2c-6, b2c-11, b2c-17): the paid orders the rules are
// holding, the 30-day figures and the latest decisions. Read only.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { Money } from '../../../common/money';
import { DbService } from '../../../infra/db';
import { deviceName, heldShare, queueMethodOf, signalsOf, tacOfInput } from '../domain/queue-view';
import {
  type DecidedRow,
  type HeldRow,
  customerHistories,
  heldOrders,
  plannedSuppliers,
  queueFigures,
  recentDecisions,
  tacEntries,
} from '../infra/foreign-reads.repository';

/** How many decisions the "Decided recently" list shows. */
export const RECENT_DECISIONS = 6;

/** How far back the strip's figures look. */
export const STATS_WINDOW_DAYS = 30;

/** A held order as the console reads it. */
export interface HeldOrderView {
  readonly orderId: number;
  readonly paidAt: string;
  readonly score: number;
  readonly service: { readonly id: number; readonly name: string };
  readonly supplier: { readonly id: number; readonly name: string } | null;
  readonly imei: string;
  readonly device: string | null;
  readonly capturedAmount: string;
  readonly currency: string;
  readonly fxRate: string;
  readonly paymentMethod: 'card' | 'wallet' | 'crypto';
  readonly signals: string[];
  readonly customer: {
    readonly id: number;
    readonly name: string;
    readonly email: string;
    readonly country: string;
    readonly riskLevel: 'low' | 'medium' | 'high';
    readonly history: { readonly earlierOrders: number; readonly refunds: number; readonly disputes: number };
  };
}

/** A decided order as the console reads it. */
export interface DecidedOrderView {
  readonly orderId: number;
  readonly score: number;
  readonly customer: { readonly id: number; readonly name: string };
  readonly capturedAmount: string;
  readonly currency: string;
  readonly fxRate: string;
  readonly outcome: 'approved' | 'refunded';
  readonly reviewedBy: { readonly id: number; readonly name: string } | null;
  readonly reviewedAt: string;
}

/** The answer of GET /admin/risk/queue. */
export interface RiskQueueView {
  readonly held: HeldOrderView[];
  readonly stats: {
    readonly decided30d: number;
    readonly approved30d: number;
    readonly refunded30d: number;
    readonly heldShare: number;
  };
  readonly recent: DecidedOrderView[];
}

/**
 * The amount the customer paid in USD, VAT included.
 *
 * Why: the checkout session locked the USD gross (the figure the Refunds page shows as the payment's amount), so the queue prints that
 * one. An order without a session falls back to its net price plus its VAT, both USD.
 */
const capturedOf = (row: { grossUsd: string | null; totalPrice: string; taxAmount: string }): string =>
  Money.of(row.grossUsd ?? Money.of(row.totalPrice).add(Money.of(row.taxAmount)).toWire()).toWire();

/**
 * Builds the review queue.
 *
 * Why: the console's Risk page polls it every 30 seconds. A held order is a storefront order whose newest assessment says `review`
 * and that was never dispatched; the oldest payment is first. The server joins everything the reviewer needs on the card (service,
 * the supplier it would go to, the IMEI and its device, what was paid and in which currency, the signals and the buyer's history),
 * so the console makes one call.
 *
 * Side effects: none (reads only; nothing is cached because staff decide on what is shown).
 */
@Injectable()
export class RiskQueueService {
  constructor(
    private readonly db: DbService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads the queue, the figures and the latest decisions.
   *
   * @returns the three parts of the page
   */
  async get(): Promise<RiskQueueView> {
    const db = this.db.db;
    const since = new Date(this.clock.now().getTime() - STATS_WINDOW_DAYS * 86_400_000);
    const [held, figures, decided] = await Promise.all([
      heldOrders(db),
      queueFigures(db, since),
      recentDecisions(db, RECENT_DECISIONS),
    ]);
    const [suppliers, histories, devices] = await Promise.all([
      plannedSuppliers(
        db,
        held.filter((row) => row.supplierId === null).map((row) => row.serviceId),
      ),
      customerHistories(
        db,
        held.map((row) => ({ orderId: row.orderId, customerId: row.customerId })),
      ),
      tacEntries(
        db,
        held.flatMap((row) => tacOfInput(row.imei) ?? []),
      ),
    ]);
    return {
      held: held.map((row) => this.heldView(row, suppliers, histories, devices)),
      stats: {
        decided30d: figures.decided,
        approved30d: figures.approved,
        refunded30d: figures.refunded,
        heldShare: heldShare(figures.heldOrders, figures.storefrontOrders),
      },
      recent: decided.map(decidedView),
    };
  }

  private heldView(
    row: HeldRow,
    suppliers: Awaited<ReturnType<typeof plannedSuppliers>>,
    histories: Awaited<ReturnType<typeof customerHistories>>,
    devices: Awaited<ReturnType<typeof tacEntries>>,
  ): HeldOrderView {
    const tac = tacOfInput(row.imei);
    const supplier =
      row.supplierId !== null && row.supplierName !== null
        ? { id: row.supplierId, name: row.supplierName }
        : (suppliers.get(row.serviceId) ?? null);
    return {
      orderId: row.orderId,
      paidAt: (row.capturedAt ?? row.orderCreatedAt).toISOString(),
      score: row.score,
      service: { id: row.serviceId, name: row.serviceName },
      supplier,
      imei: row.imei ?? '',
      device: tac === null ? null : deviceName(devices.get(tac)),
      capturedAmount: capturedOf(row),
      currency: row.currency ?? 'USD',
      fxRate: row.fxRate ?? '1',
      paymentMethod: queueMethodOf(row.methodType),
      signals: signalsOf(row.signals),
      customer: {
        id: row.customerId,
        name: row.customerName,
        email: row.customerEmail,
        country: row.customerCountry,
        riskLevel: row.customerRisk,
        history: histories.get(row.orderId) ?? { earlierOrders: 0, refunds: 0, disputes: 0 },
      },
    };
  }
}

function decidedView(row: DecidedRow): DecidedOrderView {
  return {
    orderId: row.orderId,
    score: row.score,
    customer: { id: row.customerId, name: row.customerName },
    capturedAmount: capturedOf(row),
    currency: row.currency ?? 'USD',
    fxRate: row.fxRate ?? '1',
    outcome: row.outcome,
    reviewedBy:
      row.reviewerId === null || row.reviewerName === null ? null : { id: row.reviewerId, name: row.reviewerName },
    reviewedAt: row.reviewedAt.toISOString(),
  };
}
