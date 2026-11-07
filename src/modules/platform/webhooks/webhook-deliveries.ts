// WebhookDeliveries: sends one attempt of a delivery to the merchant's endpoint, records what came back, schedules the next
// attempt, and queues the jobs of deliveries (decisions 019, 020, 023; ALIGNMENT § 7).
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DecryptionError, EncryptionService, WEBHOOK_SIGNATURE_HEADER, signWebhook } from '../../../infra/crypto';
import { DbService } from '../../../infra/db';
import { HttpRequestError, OutboundHttp, type HttpFailure } from '../../../infra/http';
import { QueuesService, queueJobId } from '../../../infra/queues';
import type { WebhookDelivery } from '../db/schema';
import {
  WEBHOOK_ERROR_LIMIT,
  WEBHOOK_MAX_RESPONSE_BYTES,
  WEBHOOK_TIMEOUT_MS,
  nextStep,
  storableBody,
  truncate,
} from './webhook-delivery.rules';
import {
  type AttemptOutcome,
  type AttemptResult,
  findDeliveryToSend,
  recordAttempt,
} from './webhook-delivery.repository';
import { bumpFailureCount, resetFailureCount } from './webhook-endpoint.repository';
import { WEBHOOK_TARGET_POLICY, type WebhookTargetPolicy } from './webhook-target-policy';

/** The queue every webhook job runs on, and the name of the job that sends one attempt of a delivery. */
export const WEBHOOK_QUEUE = 'merchant-webhooks';
/** The job name of one attempt of a delivery. */
export const WEBHOOK_DELIVER_JOB = 'webhook.deliver';
/** The AAD of the endpoint secrets (decision 019: `<table>.<column>`). */
export const WEBHOOK_SECRET_AAD = 'webhook_endpoints.secret_enc';

/** The data of a delivery job: ids only. */
export interface WebhookJobData {
  readonly deliveryId: number;
  /** The attempt the job sends; a job for an attempt the delivery has moved past does nothing. */
  readonly attempt: number;
}

/** What one run of a delivery job did (kept briefly with the BullMQ job). */
export interface DeliverResult {
  readonly outcome: 'delivered' | 'retry_scheduled' | 'failed' | 'resumed' | 'skipped';
  /** Why nothing was sent. */
  readonly skipped?: 'gone' | 'not_pending' | 'stale' | 'lost_race';
  readonly responseCode?: number;
}

/** What the merchant's server did, before it is turned into a stored result. */
type Sent =
  | { readonly kind: 'answered'; readonly status: number; readonly body: string | null }
  | { readonly kind: 'no_answer'; readonly failure: HttpFailure; readonly message: string };

/** How a failed call is worded for the log and the console. */
function failureText(error: HttpRequestError): string {
  switch (error.kind) {
    case 'timeout':
      return `The endpoint did not answer within ${WEBHOOK_TIMEOUT_MS / 1000} seconds.`;
    case 'network':
      return 'The endpoint could not be reached (the connection failed).';
    case 'too_large':
      return `The answer was larger than ${WEBHOOK_MAX_RESPONSE_BYTES / 1024} KB.`;
    case 'blocked':
      return truncate(error.message, WEBHOOK_ERROR_LIMIT);
    case 'aborted':
      return 'The request was cancelled.';
  }
}

/**
 * Sends the attempts of merchant webhook deliveries.
 *
 * Why: B156 and ALIGNMENT § 7. A delivery is one `webhook_deliveries` row per event and endpoint; the worker sends it as a signed
 * POST (`X-GSM-Signature`, `X-GSM-Event-Id`), keeps what the merchant answered, and retries with exponential backoff and jitter
 * up to 8 attempts over about 21 hours, then marks it `failed`. The row is the truth: the attempt number, the next due time and
 * the result live in Postgres, and the BullMQ job is only the alarm clock (deterministic id `webhook-<delivery>-<attempt>`, so
 * adding it twice creates one job). A job that runs twice, or after a manual retry, finds the row on another attempt and does
 * nothing. A job whose row says the next attempt is already scheduled only makes sure that attempt has its job.
 * The address is checked again at every send (decision 023): a host that now resolves to a private address is refused and the
 * delivery fails at once, because waiting cannot change that.
 *
 * Side effects: one HTTP POST per attempt; updates `webhook_deliveries` and `webhook_endpoints.failure_count`; adds jobs to the
 * `merchant-webhooks` queue.
 *
 * @see docs/queues.md (merchant-webhooks)
 */
@Injectable()
export class WebhookDeliveries {
  private readonly logger = new Logger(WebhookDeliveries.name);

  constructor(
    private readonly db: DbService,
    private readonly queues: QueuesService,
    private readonly outbound: OutboundHttp,
    private readonly encryption: EncryptionService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(WEBHOOK_TARGET_POLICY) private readonly policy?: WebhookTargetPolicy,
  ) {}

  /**
   * Makes sure each pending delivery has the job of its current attempt.
   *
   * Why: adding a job with an id that is already taken creates nothing, so this is safe to call again and again: after a fan-out,
   * after a manual retry, and when a job finds its row moved on. The job waits until the delivery's due time.
   *
   * Side effects: adds jobs to the `merchant-webhooks` queue.
   *
   * @param deliveries the deliveries to check (rows that are not `pending` are skipped)
   * @throws {AppError} `UNAVAILABLE` when the queue Redis cannot take a job; the caller's job then fails and is retried
   */
  async ensureJobs(deliveries: readonly WebhookDelivery[]): Promise<void> {
    const nowMs = this.clock.nowMs();
    for (const delivery of deliveries) {
      if (delivery.status !== 'pending') continue;
      const due = delivery.nextRetryAt?.getTime() ?? nowMs;
      const data: WebhookJobData = { deliveryId: delivery.id, attempt: delivery.attempt };
      await this.queues.add(WEBHOOK_QUEUE, WEBHOOK_DELIVER_JOB, data, {
        jobId: queueJobId('webhook', delivery.id, delivery.attempt),
        delay: Math.max(0, due - nowMs),
      });
    }
  }

  /**
   * Runs one attempt of a delivery.
   *
   * @param job the delivery and the attempt the job was made for
   * @returns what happened; nothing is thrown for a refusal by the merchant's server (it is recorded and retried)
   * @throws {Error} when Postgres or the queue Redis fails (the BullMQ job is retried; the guarded write makes that safe)
   */
  async deliver(job: WebhookJobData): Promise<DeliverResult> {
    const found = await findDeliveryToSend(this.db.db, job.deliveryId);
    if (!found) return { outcome: 'skipped', skipped: 'gone' };
    const { delivery, endpoint } = found;
    if (delivery.status !== 'pending') return { outcome: 'skipped', skipped: 'not_pending' };
    if (delivery.attempt > job.attempt) {
      // The row moved past this job: a retry was queued by hand, or the result of this attempt was written but its next job
      // was not. Either way the current attempt needs its job; adding it again is harmless.
      await this.ensureJobs([delivery]);
      return { outcome: 'resumed' };
    }
    if (delivery.attempt < job.attempt) return { outcome: 'skipped', skipped: 'stale' };

    if (!endpoint.isActive) {
      await this.finish(
        delivery,
        endpoint.id,
        { status: 'failed' },
        { responseCode: null, responseBody: null, error: 'The endpoint is switched off.' },
      );
      return { outcome: 'failed' };
    }

    let secret: string;
    try {
      secret = this.encryption.decrypt(endpoint.secretEnc, WEBHOOK_SECRET_AAD);
    } catch (error) {
      if (!(error instanceof DecryptionError)) throw error;
      this.logger.error(`The signing secret of webhook endpoint ${endpoint.id} cannot be decrypted (${error.reason}).`);
      await this.finish(
        delivery,
        endpoint.id,
        { status: 'failed' },
        { responseCode: null, responseBody: null, error: 'The signing secret cannot be read.' },
      );
      return { outcome: 'failed' };
    }

    const sent = await this.send(endpoint.url, secret, delivery);
    const { outcome, result } = this.judge(delivery.attempt, sent);
    const recorded = await this.finish(delivery, endpoint.id, outcome, result);
    if (!recorded) return { outcome: 'skipped', skipped: 'lost_race' };
    if (outcome.status === 'pending') {
      await this.ensureJobs([{ ...delivery, attempt: outcome.attempt, nextRetryAt: outcome.nextRetryAt }]);
      return {
        outcome: 'retry_scheduled',
        ...(result.responseCode === null ? {} : { responseCode: result.responseCode }),
      };
    }
    return {
      outcome: outcome.status === 'delivered' ? 'delivered' : 'failed',
      ...(result.responseCode === null ? {} : { responseCode: result.responseCode }),
    };
  }

  /** Signs and posts the envelope; a call that got no answer is returned, not thrown. */
  private async send(url: string, secret: string, delivery: WebhookDelivery): Promise<Sent> {
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(this.clock.nowMs() / 1000);
    try {
      const response = await this.outbound.request({
        target: 'merchant_webhook',
        operation: 'webhook.delivery',
        url,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'GSM-Webhooks/1',
          [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, timestamp, body),
          'X-GSM-Event-Id': delivery.eventId,
        },
        body,
        timeoutMs: WEBHOOK_TIMEOUT_MS,
        maxResponseBytes: WEBHOOK_MAX_RESPONSE_BYTES,
        httpsOnly: this.policy?.httpsOnly ?? true,
        ...(this.policy?.allowPrivateNetwork === undefined
          ? {}
          : { allowPrivateNetwork: this.policy.allowPrivateNetwork }),
        ...(this.policy?.lookup === undefined ? {} : { lookup: this.policy.lookup }),
      });
      return { kind: 'answered', status: response.status, body: storableBody(response.body) };
    } catch (error) {
      if (!(error instanceof HttpRequestError)) throw error;
      return { kind: 'no_answer', failure: error.kind, message: failureText(error) };
    }
  }

  /** Turns what was sent into the delivery's next state and the stored result. */
  private judge(attempt: number, sent: Sent): { outcome: AttemptOutcome; result: AttemptResult } {
    if (sent.kind === 'answered') {
      const result = { responseCode: sent.status, responseBody: sent.body, error: null };
      if (sent.status >= 200 && sent.status < 300) return { outcome: { status: 'delivered' }, result };
      return { outcome: this.afterFailure(attempt, false), result };
    }
    return {
      // An address the SSRF guard refuses is refused again next time: waiting cannot help.
      outcome: this.afterFailure(attempt, sent.failure === 'blocked'),
      result: { responseCode: null, responseBody: null, error: sent.message },
    };
  }

  /** The state after a failed attempt: waiting for the next one, or failed. */
  private afterFailure(attempt: number, permanent: boolean): AttemptOutcome {
    const step = nextStep(attempt, permanent, Math.random());
    if (step.kind === 'give_up') return { status: 'failed' };
    return { status: 'pending', attempt: step.attempt, nextRetryAt: new Date(this.clock.nowMs() + step.delayMs) };
  }

  /** Writes the result and the endpoint's failure counter in one transaction; false when another writer got there first. */
  private async finish(
    delivery: WebhookDelivery,
    endpointId: number,
    outcome: AttemptOutcome,
    result: AttemptResult,
  ): Promise<boolean> {
    return this.db.runInTransaction(async ({ tx }) => {
      const written = await recordAttempt(tx, delivery.id, delivery.attempt, outcome, result);
      if (!written) return false;
      if (outcome.status === 'delivered') await resetFailureCount(tx, endpointId);
      else await bumpFailureCount(tx, endpointId);
      return true;
    });
  }
}
