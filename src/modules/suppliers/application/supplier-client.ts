// SupplierClient: the one place that calls suppliers (decisions 019, 021, 023, 026). It decrypts the supplier's key for one call, picks
// the driver, applies the environment's call policy and returns the record the caller writes to `supplier_api_logs`. SupplierThrottle
// holds the per-supplier limits (concurrent calls and calls per minute).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { DecryptionError, EncryptionService } from '../../../infra/crypto';
import { OutboundHttp } from '../../../infra/http';
import { RateLimitService, type SemaphoreLease } from '../../../infra/rate-limit';
import { SettingsReader } from '../../platform';
import type { AccountInfo, RemoteService, SupplierOrderStatus } from '../domain/dhru-protocol';
import type { Supplier } from '../db/schema';
import {
  type DriverCall,
  type DriverContext,
  type PlaceOrderInput,
  type SupplierDriver,
  DhruDriver,
  RestDriver,
} from './supplier-driver';
import { SUPPLIER_PLAIN_HTTP_KEY, SUPPLIER_TARGET_POLICY, type SupplierTargetPolicy } from './supplier-target-policy';

/** The AAD of the encrypted supplier key (decision 019: `<table>.<column>`). */
export const SUPPLIER_KEY_AAD = 'suppliers.api_key_enc';

/** The part of a supplier a call needs. */
export type CallableSupplier = Pick<Supplier, 'id' | 'driver' | 'baseUrl' | 'username' | 'apiKeyEnc' | 'timeoutMs'>;

/**
 * Calls suppliers.
 *
 * Why: orders-suppliers and decision 026: every supplier call goes through `OutboundHttp` (the SSRF guard, a required timeout, no
 * redirects) behind a driver. The key is decrypted here for the length of the call, never read on a page and never logged. The call
 * policy is `https` in production unless the setting `suppliers.allowPlainHttp` is on; tests provide `SUPPLIER_TARGET_POLICY` to reach
 * a local fake supplier.
 *
 * Side effects: one outbound HTTP exchange per call (metric and log line of `OutboundHttp`); reads the settings snapshot. It writes no
 * log row: the caller does, with the record of the answer.
 */
@Injectable()
export class SupplierClient {
  private readonly dhru: SupplierDriver;
  private readonly rest: SupplierDriver = new RestDriver();

  constructor(
    http: OutboundHttp,
    private readonly encryption: EncryptionService,
    private readonly settings: SettingsReader,
    @Optional() @Inject(SUPPLIER_TARGET_POLICY) private readonly policy?: SupplierTargetPolicy,
  ) {
    this.dhru = new DhruDriver(http);
  }

  /**
   * Asks the supplier for our balance.
   *
   * @param supplier the supplier
   * @returns the balance, or why the call failed, with the record for the log
   */
  accountInfo(supplier: CallableSupplier): Promise<DriverCall<AccountInfo>> {
    return this.run(supplier, 'accountinfo', (driver, context) => driver.accountInfo(context));
  }

  /**
   * Asks the supplier for its service list.
   *
   * @param supplier the supplier
   * @returns the services, or why the call failed, with the record for the log
   */
  serviceList(supplier: CallableSupplier): Promise<DriverCall<RemoteService[]>> {
    return this.run(supplier, 'imeiservicelist', (driver, context) => driver.serviceList(context));
  }

  /**
   * Places an order at the supplier.
   *
   * @param supplier the supplier
   * @param order the supplier's service, the input, the quantity and the custom fields
   * @returns the supplier's reference, or why the call failed, with the record for the log
   */
  placeOrder(supplier: CallableSupplier, order: PlaceOrderInput): Promise<DriverCall<{ reference: string }>> {
    return this.run(supplier, 'placeimeiorder', (driver, context) => driver.placeOrder(context, order));
  }

  /**
   * Asks the supplier for the status of an order.
   *
   * @param supplier the supplier
   * @param reference the supplier's reference of the order
   * @returns the state and the CODE, or why the call failed, with the record for the log
   */
  getOrder(supplier: CallableSupplier, reference: string): Promise<DriverCall<SupplierOrderStatus>> {
    return this.run(supplier, 'getimeiorder', (driver, context) => driver.getOrder(context, reference));
  }

  private async run<T>(
    supplier: CallableSupplier,
    action: string,
    call: (driver: SupplierDriver, context: DriverContext) => Promise<DriverCall<T>>,
  ): Promise<DriverCall<T>> {
    const configFailure = (message: string): DriverCall<T> => ({
      ok: false,
      kind: 'config',
      message,
      record: {
        action,
        request: { action },
        response: null,
        httpStatus: 0,
        durationMs: 0,
        error: message,
        outcome: 'error',
      },
    });
    if (supplier.apiKeyEnc === null) return configFailure('No API key is saved for this supplier.');
    let apiKey: string;
    try {
      apiKey = this.encryption.decrypt(supplier.apiKeyEnc, SUPPLIER_KEY_AAD);
    } catch (error) {
      if (error instanceof DecryptionError)
        return configFailure('The saved API key cannot be read: save the key again.');
      throw error;
    }
    const plainHttp = (await this.settings.get(SUPPLIER_PLAIN_HTTP_KEY)) === true;
    const context: DriverContext = {
      baseUrl: supplier.baseUrl,
      username: supplier.username,
      apiKey,
      timeoutMs: supplier.timeoutMs,
      policy: {
        ...(this.policy?.allowPrivateNetwork === undefined
          ? {}
          : { allowPrivateNetwork: this.policy.allowPrivateNetwork }),
        ...(this.policy?.lookup === undefined ? {} : { lookup: this.policy.lookup }),
        ...(this.policy?.httpsOnly !== undefined
          ? { httpsOnly: this.policy.httpsOnly }
          : plainHttp
            ? { httpsOnly: false }
            : {}),
      },
    };
    return call(supplier.driver === 'rest' ? this.rest : this.dhru, context);
  }
}

/** What {@link SupplierThrottle.admit} answers. */
export type Admission =
  | { readonly ok: true; readonly lease: SemaphoreLease }
  | { readonly ok: false; readonly reason: 'busy' | 'rate_limited'; readonly retryAfterSeconds: number };

/**
 * Applies a supplier's own limits to the calls we make to it.
 *
 * Why: decision 021 and the brief: `suppliers.max_concurrency` (a semaphore) and `suppliers.rate_limit_per_min` (the `supplier`
 * limiter) keep us inside what the supplier tolerates; a caller that is refused delays itself instead of failing.
 *
 * Side effects: a lease in the supplier's semaphore and a point on its limiter, both on the cache Redis, with TTLs.
 */
@Injectable()
export class SupplierThrottle {
  constructor(private readonly limits: RateLimitService) {}

  /**
   * Asks to make one call.
   *
   * @param supplier the supplier's limits
   * @returns a lease to give back with {@link SupplierThrottle.release}, or why the call must wait
   */
  async admit(supplier: Pick<Supplier, 'id' | 'maxConcurrency' | 'rateLimitPerMin' | 'timeoutMs'>): Promise<Admission> {
    const lease = await this.limits.acquire(
      `supplier-${supplier.id}`,
      supplier.maxConcurrency,
      supplier.timeoutMs + 10_000,
    );
    if (!lease) return { ok: false, reason: 'busy', retryAfterSeconds: 2 };
    const rate = await this.limits.consume('supplier', String(supplier.id), 1, { limit: supplier.rateLimitPerMin });
    if (!rate.allowed) {
      await this.limits.release(lease);
      return { ok: false, reason: 'rate_limited', retryAfterSeconds: rate.retryAfterSeconds };
    }
    return { ok: true, lease };
  }

  /**
   * Gives a call's place back (always in a `finally`).
   *
   * @param lease the lease of {@link SupplierThrottle.admit}
   * @returns resolves when the place is free again (never throws)
   */
  release(lease: SemaphoreLease): Promise<void> {
    return this.limits.release(lease);
  }
}
