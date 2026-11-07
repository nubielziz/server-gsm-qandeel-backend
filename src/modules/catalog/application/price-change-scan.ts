// PriceChangeScan: after a price change, finds the merchants who ordered a service in the last 30 days and would now pay a different
// price, and writes one outbox event `service.price_changed` for each (user rule 9 (5), MISMATCHES B117; feature 7b).
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { QueuesService, queueJobId } from '../../../infra/queues';
import { OutboxService, SERVICE_PRICE_CHANGED_EVENT } from '../../platform';
import { recentOrderPrices } from '../infra/foreign-reads.repository';
import { Money } from '../../../common/money';
import { PriceResolver } from './price-resolver';
import { type PriceVersionListener, PriceVersionListeners } from './price-version-listeners';

/** The job that runs the scan, on the `maintenance` queue. */
export const PRICE_SCAN_JOB = 'service_price_scan';
/** Merchants who ordered the service within this many days are told about its price (user rule 9). */
export const PRICE_SCAN_WINDOW_DAYS = 30;
/** Pairs of merchant and service judged per step. */
export const PRICE_SCAN_BATCH = 500;
/** The scan runs at most once a minute and waits this long after the first change, so a burst of edits is one scan. */
export const PRICE_SCAN_DELAY_MS = 60_000;

const DAY_MS = 86_400_000;

/** What one scan did (kept briefly with the BullMQ job). */
export interface PriceScanResult {
  /** Pairs of merchant and service compared. */
  readonly checked: number;
  /** Events written for a price that differs from the last order. */
  readonly announced: number;
}

/**
 * Detects price changes that reach merchants.
 *
 * Why: the price a merchant pays comes from the resolver (client price, group price, rules, discount, the cost floor), and a dozen
 * writers change what feeds it, each calling `CatalogPriceVersion.bumpAfterCommit`. Rather than every writer working out who is
 * affected, the version's bump asks for one scan (at most one a minute): for every merchant and service of the last 30 days of
 * orders, it resolves the price a new order would pay now and compares it with the price of the merchant's latest order. A
 * difference is announced once: the outbox row is written only if no row for that change exists (`OutboxService.hasEvent`), and the
 * webhook fan-out is idempotent on the same change as well. The event carries ids and the two prices (public to the merchant).
 *
 * Side effects: `schedule` adds a delayed job to the `maintenance` queue; `run` reads `orders`, `clients` and the pricing tables and
 * inserts `outbox_events` rows (type `service.price_changed`, aggregate `services`).
 *
 * @see docs/queues.md (maintenance, service_price_scan)
 */
@Injectable()
export class PriceChangeScan implements PriceVersionListener, OnModuleInit {
  private readonly logger = new Logger(PriceChangeScan.name);

  constructor(
    private readonly db: DbService,
    private readonly pricing: PriceResolver,
    private readonly outbox: OutboxService,
    private readonly queues: QueuesService,
    private readonly listeners: PriceVersionListeners,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Registers with the price version, so every move of it asks for a scan. */
  onModuleInit(): void {
    this.listeners.add(this);
  }

  /** Called by the price version after it moved: asks for a scan. */
  async priceVersionMoved(): Promise<void> {
    await this.schedule();
  }

  /**
   * Asks for a scan soon. Never throws: a price change must not fail because the queue is away (the next change asks again).
   *
   * @returns true when a job was added or already waits for this minute
   */
  async schedule(): Promise<boolean> {
    try {
      const minute = Math.floor(this.clock.nowMs() / 60_000);
      await this.queues.add(
        'maintenance',
        PRICE_SCAN_JOB,
        {},
        { jobId: queueJobId('price-scan', minute), delay: PRICE_SCAN_DELAY_MS },
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not schedule the price change scan: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * Compares the price every recent buyer would pay now with the price of its last order, and announces the differences.
   *
   * @returns how many pairs were compared and how many events were written
   * @throws {Error} when Postgres fails (the job is retried; an event already written is not written again)
   */
  async run(): Promise<PriceScanResult> {
    const now = this.clock.now();
    const since = new Date(now.getTime() - PRICE_SCAN_WINDOW_DAYS * DAY_MS);
    let checked = 0;
    let announced = 0;
    let after: { clientId: number; serviceId: number } | undefined;
    for (;;) {
      const page = await recentOrderPrices(this.db.db, since, after, PRICE_SCAN_BATCH);
      if (page.length === 0) break;
      const context = await this.pricing.context(this.db.db, {
        serviceIds: page.map((row) => row.serviceId),
        clientIds: page.map((row) => row.clientId),
        at: now,
      });
      const changes = page.flatMap((row) => {
        const resolution = context.resolve({ serviceId: row.serviceId, groupId: row.groupId, clientId: row.clientId });
        return resolution && Money.of(row.lastPrice).cmp(resolution.price) !== 0
          ? [
              {
                clientId: row.clientId,
                serviceId: row.serviceId,
                previousPrice: Money.of(row.lastPrice).toWire(),
                price: resolution.price.toWire(),
              },
            ]
          : [];
      });
      if (changes.length > 0) {
        announced += await this.db.runInTransaction(async ({ tx }) => {
          let written = 0;
          for (const change of changes) {
            const payload = { ...change, currency: 'USD' };
            if (await this.outbox.hasEvent(tx, SERVICE_PRICE_CHANGED_EVENT, 'services', change.serviceId, payload))
              continue;
            await this.outbox.add(tx, {
              type: SERVICE_PRICE_CHANGED_EVENT,
              aggregateType: 'services',
              aggregateId: change.serviceId,
              payload,
            });
            written += 1;
          }
          return written;
        });
      }
      checked += page.length;
      const last = page[page.length - 1]!;
      after = { clientId: last.clientId, serviceId: last.serviceId };
      if (page.length < PRICE_SCAN_BATCH) break;
    }
    return { checked, announced };
  }
}
