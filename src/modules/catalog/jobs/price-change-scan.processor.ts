// The worker job that scans for price changes that reach merchants (catalog module, queue maintenance, job service_price_scan).
import { Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { type JobProcessor, QueueProcessor } from '../../../infra/queues';
import { PRICE_SCAN_JOB, type PriceScanResult, PriceChangeScan } from '../application/price-change-scan';

/**
 * Runs the price change scan when its delayed job arrives.
 *
 * Why: every move of the catalog price version asks for a scan one minute later (`PriceChangeScan.schedule`); the scan writes the
 * `service.price_changed` outbox events that the webhook fan-out turns into deliveries. It is event-driven, not scheduled, so it
 * writes no `job_runs` row (like the merchant mail jobs); a repeated run writes nothing new.
 */
@Injectable()
@QueueProcessor('maintenance', PRICE_SCAN_JOB)
export class PriceChangeScanProcessor implements JobProcessor<object, PriceScanResult> {
  constructor(private readonly scan: PriceChangeScan) {}

  /**
   * Handles one scan job.
   *
   * @param _job the BullMQ job (its data is empty)
   * @returns how many pairs were compared and how many events were written
   */
  process(_job: Job<object, PriceScanResult, string>): Promise<PriceScanResult> {
    return this.scan.run();
  }
}
