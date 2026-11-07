// MerchantWebhookService: the use cases of the merchant's own webhook endpoints (routes /client/webhooks, MISMATCHES B156): list,
// create (the secret is shown once), change, delete, send a test event and read the delivery log.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { EncryptionService, TokenService } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import type { MerchantRef } from './merchant-ref';
import { buildEnvelope, MAX_ENDPOINTS_PER_MERCHANT, PING_EVENT } from './webhook-delivery.rules';
import {
  type DeliverySortField,
  deleteDeliveryOf,
  insertDeliveryOnce,
  listDeliveriesOfEndpoint,
} from './webhook-delivery.repository';
import { WEBHOOK_SECRET_AAD, WebhookDeliveries } from './webhook-deliveries';
import {
  type EndpointSortField,
  countEndpointsOfClient,
  deleteEndpoint,
  findEndpoint,
  insertEndpoint,
  listEndpointsOfClient,
  lockEndpoint,
  lockEndpointsOfClient,
  updateEndpoint,
} from './webhook-endpoint.repository';
import { WEBHOOK_TARGET_POLICY, type WebhookTargetPolicy } from './webhook-target-policy';
import { webhookUrlProblem } from './webhook-url';
import { type EndpointWire, endpointToWire, portalDeliveryToWire } from './webhook-wire';

/** The range and sort of a list request, already parsed and checked by the contract. */
export interface PortalListRequest<Field extends string> {
  readonly offset: number;
  readonly limit: number;
  readonly sort: readonly { readonly field: Field; readonly order: 'asc' | 'desc' }[];
}

/** The answer of a creation: the endpoint and its signing secret, shown this once. */
export interface CreatedEndpoint {
  readonly endpoint: EndpointWire;
  readonly secret: string;
}

/** A field error of the portal's forms: `422 VALIDATION_FAILED` on one request key. */
function invalid(field: string, message: string): AppError {
  return new AppError('VALIDATION_FAILED', { errors: [{ field, code: 'invalid', message }] });
}

/** Removes repeats, keeping the order. */
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/**
 * Manages the webhook endpoints of the signed-in merchant.
 *
 * Why: B156 and decisions 019, 020, 023. A merchant registers up to five HTTPS endpoints and the events each one receives; the
 * signing secret is generated here, stored encrypted (AES-GCM, AAD `webhook_endpoints.secret_enc`) and shown once, like an API
 * key. Another merchant's endpoint is `404`, like an unknown one. Merchant routes write no audit row (B121).
 *
 * Side effects: writes `webhook_endpoints`; deleting one deletes its `webhook_deliveries`; `test` inserts a `webhook_deliveries`
 * row and adds a job to the `merchant-webhooks` queue; a changed address costs one DNS lookup.
 *
 * @see docs/contract/MISMATCHES.md (B156)
 */
@Injectable()
export class MerchantWebhookService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly encryption: EncryptionService,
    private readonly deliveries: WebhookDeliveries,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(WEBHOOK_TARGET_POLICY) private readonly policy?: WebhookTargetPolicy,
  ) {}

  /**
   * Lists the merchant's endpoints, newest first by default.
   *
   * @param merchant the signed-in merchant
   * @param request the range and the sort keys
   * @returns the endpoints in the range and the exact total
   */
  async list(merchant: MerchantRef, request: PortalListRequest<EndpointSortField>) {
    const { rows, total } = await listEndpointsOfClient(this.db.db, merchant.clientId, request);
    return { rows: rows.map(endpointToWire), total };
  }

  /**
   * Creates an endpoint and returns its signing secret once.
   *
   * @param merchant the signed-in merchant
   * @param input the address, the events and whether it starts switched on (default on)
   * @returns the endpoint and the secret
   * @throws {AppError} `VALIDATION_FAILED` (422) on `url` (not https, a private host, an unknown host, or the merchant already
   *   has 5 endpoints)
   */
  async create(
    merchant: MerchantRef,
    input: { readonly url: string; readonly events: readonly string[]; readonly isActive?: boolean | undefined },
  ): Promise<CreatedEndpoint> {
    const problem = await webhookUrlProblem(input.url, this.policy?.lookup);
    if (problem) throw invalid('url', problem);
    const secret = `whsec_${this.tokens.random(32)}`;
    const row = await this.db.runInTransaction(async ({ tx }) => {
      // Two requests at once would both see four endpoints; the lock lets the second count after the first commits.
      await lockEndpointsOfClient(tx, merchant.clientId);
      if ((await countEndpointsOfClient(tx, merchant.clientId)) >= MAX_ENDPOINTS_PER_MERCHANT) {
        throw invalid('url', `You can register ${MAX_ENDPOINTS_PER_MERCHANT} endpoints; delete one first.`);
      }
      return insertEndpoint(tx, {
        clientId: merchant.clientId,
        url: input.url,
        secretEnc: this.encryption.encrypt(secret, WEBHOOK_SECRET_AAD),
        events: unique(input.events),
        isActive: input.isActive ?? true,
      });
    });
    return { endpoint: endpointToWire(row), secret };
  }

  /**
   * Changes an endpoint.
   *
   * @param merchant the signed-in merchant
   * @param id the endpoint id
   * @param changes the fields to change; a missing one stays as it is
   * @returns the endpoint after the change; turning it on again resets its failure count
   * @throws {AppError} `NOT_FOUND` (404); `VALIDATION_FAILED` (422) on `url`
   */
  async update(
    merchant: MerchantRef,
    id: number,
    changes: {
      readonly url?: string | undefined;
      readonly events?: readonly string[] | undefined;
      readonly isActive?: boolean | undefined;
    },
  ): Promise<EndpointWire> {
    if (changes.url !== undefined) {
      const problem = await webhookUrlProblem(changes.url, this.policy?.lookup);
      if (problem) throw invalid('url', problem);
    }
    return this.db.runInTransaction(async ({ tx }) => {
      const row = await lockEndpoint(tx, id);
      if (!row || row.clientId !== merchant.clientId)
        throw new AppError('NOT_FOUND', { detail: 'No such webhook endpoint.' });
      const switchingOn = changes.isActive === true && !row.isActive;
      const updated = await updateEndpoint(tx, id, {
        ...(changes.url === undefined ? {} : { url: changes.url }),
        ...(changes.events === undefined ? {} : { events: unique(changes.events) }),
        ...(changes.isActive === undefined ? {} : { isActive: changes.isActive }),
        ...(switchingOn ? { failureCount: 0 } : {}),
      });
      return endpointToWire(updated);
    });
  }

  /**
   * Deletes an endpoint and its delivery log.
   *
   * @param merchant the signed-in merchant
   * @param id the endpoint id
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async remove(merchant: MerchantRef, id: number): Promise<void> {
    await this.db.runInTransaction(async ({ tx }) => {
      const row = await lockEndpoint(tx, id);
      if (!row || row.clientId !== merchant.clientId)
        throw new AppError('NOT_FOUND', { detail: 'No such webhook endpoint.' });
      await deleteEndpoint(tx, id);
    });
  }

  /**
   * Queues a signed test delivery of the event `ping`.
   *
   * @param merchant the signed-in merchant
   * @param id the endpoint id
   * @returns the id of the delivery; its progress is in the endpoint's delivery log
   * @throws {AppError} `NOT_FOUND` (404); `INVALID_TRANSITION` (409) for a paused endpoint; `UNAVAILABLE` (503) when the queue
   *   cannot take the job (the delivery is removed again, so nothing is left waiting)
   */
  async test(merchant: MerchantRef, id: number): Promise<{ deliveryId: number }> {
    const endpoint = await findEndpoint(this.db.db, id);
    if (!endpoint || endpoint.clientId !== merchant.clientId)
      throw new AppError('NOT_FOUND', { detail: 'No such webhook endpoint.' });
    if (!endpoint.isActive)
      throw new AppError('INVALID_TRANSITION', { detail: 'This endpoint is switched off. Turn it on to send a test.' });
    const now = this.clock.now();
    // 18 random bytes make exactly 24 base64url characters, the length of every other event id.
    const eventId = `evt_${this.tokens.random(18)}`;
    const data = { message: 'This is a test event from GSM.', endpointId: endpoint.id };
    const delivery = await this.db.runInTransaction(({ tx }) =>
      insertDeliveryOnce(tx, {
        endpointId: endpoint.id,
        event: PING_EVENT,
        eventId,
        payload: { ...buildEnvelope(eventId, PING_EVENT, now, data) },
        nextRetryAt: now,
      }),
    );
    if (!delivery) throw new Error(`The test delivery ${eventId} already exists.`);
    try {
      await this.deliveries.ensureJobs([delivery]);
    } catch (error) {
      await this.db.runInTransaction(({ tx }) => deleteDeliveryOf(tx, delivery.id));
      throw error;
    }
    return { deliveryId: delivery.id };
  }

  /**
   * Lists the deliveries of one endpoint, newest first by default.
   *
   * @param merchant the signed-in merchant
   * @param id the endpoint id
   * @param request the range and the sort keys
   * @returns the deliveries in the range and the exact total
   * @throws {AppError} `NOT_FOUND` (404)
   */
  async deliveriesOf(merchant: MerchantRef, id: number, request: PortalListRequest<DeliverySortField>) {
    const endpoint = await findEndpoint(this.db.db, id);
    if (!endpoint || endpoint.clientId !== merchant.clientId)
      throw new AppError('NOT_FOUND', { detail: 'No such webhook endpoint.' });
    const { rows, total } = await listDeliveriesOfEndpoint(this.db.db, id, request);
    return { rows: rows.map(portalDeliveryToWire), total };
  }
}
