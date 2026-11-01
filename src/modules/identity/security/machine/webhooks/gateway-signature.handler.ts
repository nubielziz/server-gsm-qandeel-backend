// The access handler of incoming gateway webhooks (decision 018, 019): signature by the gateway's adapter, the 5 minute window,
// and the event-id replay filter. Builds on the raw body kept for the `/webhooks` surface (src/common/raw-body.ts).
import { Logger, type ExecutionContext } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AnyRouteContract } from '../../../../../common/contract';
import { AppError } from '../../../../../common/errors';
import { rawBodyOf } from '../../../../../common/raw-body';
import { WEBHOOK_TOLERANCE_SECONDS } from '../../../../../infra/crypto';
import type { AccessHandler } from '../../access-handlers';
import type { AccessState } from '../../access-state';
import type { WebhookEventLedger } from './webhook-event-ledger';
import type { VerifiedDelivery, WebhookVerifiers } from './webhook-verifiers';

const MAX_EVENT_ID_LENGTH = 256;

/** Reads the gateway slug from the `:gateway` path parameter, lower case. */
function gatewayOf(request: FastifyRequest): string | undefined {
  const gateway = (request.params as Record<string, unknown> | null | undefined)?.gateway;
  return typeof gateway === 'string' ? gateway.toLowerCase() : undefined;
}

/** An adapter must return an event id and a time; anything else is a bug in the adapter, not in the request. */
function assertVerified(gateway: string, verified: VerifiedDelivery): void {
  const idOk =
    typeof verified.eventId === 'string' &&
    verified.eventId.length > 0 &&
    verified.eventId.length <= MAX_EVENT_ID_LENGTH;
  if (!idOk || !Number.isFinite(verified.timestamp)) {
    throw new AppError('INTERNAL_ERROR', {
      detail: `The "${gateway}" webhook adapter returned no usable event id or timestamp.`,
    });
  }
}

/**
 * Authenticates the routes of the `gateway-signature` access kind.
 *
 * Why: a payment confirmation moves money (`POST /webhooks/payments/:gateway`), so before the handler runs the delivery must
 * carry a valid signature of its gateway (adapter), be recent (the signed time is within 5 minutes of now, decision 019), and
 * be recognised if it was seen before (event id). The signature is checked before the time, so a caller without a valid
 * signature learns nothing about timestamps.
 *
 * A repeat of an accepted event is not refused: the gateway retries when our answer was slow, and a refusal would make it
 * retry for hours. The principal says `duplicate: true` and the handler answers `200`. The flag is a hint, because the replay
 * filter is a cache and the first delivery may still be running or may fail: the handler skips the work only when its own record
 * shows the event done, and the processing stays idempotent in Postgres.
 */
export class GatewaySignatureAccessHandler implements AccessHandler {
  private readonly logger = new Logger(GatewaySignatureAccessHandler.name);

  constructor(
    private readonly verifiers: WebhookVerifiers,
    private readonly ledger: WebhookEventLedger,
  ) {}

  /**
   * Verifies a webhook delivery.
   *
   * @param request the Fastify request
   * @param _contract the route contract (unused: the gateway comes from the URL)
   * @param context the Nest execution context (to learn the final status of the reply)
   * @returns a webhook principal: gateway, event id, signed time and whether the event was seen before
   * @throws {AppError} `WEBHOOK_SIGNATURE_INVALID` (400) for an unknown gateway, a bad signature or a time outside the window;
   *   `INTERNAL_ERROR` (500) when the raw body was not kept or the adapter misbehaves
   */
  async authenticate(
    request: FastifyRequest,
    _contract: AnyRouteContract,
    context: ExecutionContext,
  ): Promise<AccessState> {
    const gateway = gatewayOf(request);
    const verifier = gateway === undefined ? undefined : this.verifiers.get(gateway);
    if (gateway === undefined || !verifier) {
      throw new AppError('WEBHOOK_SIGNATURE_INVALID', { detail: 'No webhook is set up for this gateway.' });
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const verified = await verifier.verify({
      gateway,
      headers: request.headers,
      rawBody: this.bodyOf(request),
      nowSeconds,
    });
    assertVerified(gateway, verified);
    if (Math.abs(nowSeconds - verified.timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
      throw new AppError('WEBHOOK_SIGNATURE_INVALID', {
        detail: 'The signature timestamp is too far from the current time.',
      });
    }

    const claim = await this.ledger.claim(gateway, verified.eventId);
    if (claim === 'new') this.releaseWhenServerFails(context, gateway, verified.eventId);
    return {
      principal: {
        kind: 'webhook',
        gateway,
        eventId: verified.eventId,
        timestamp: verified.timestamp,
        duplicate: claim === 'duplicate',
        ip: request.ip,
      },
    };
  }

  /** The bytes the gateway sent; empty for a request without a body. */
  private bodyOf(request: FastifyRequest): Buffer {
    const raw = rawBodyOf(request);
    if (raw) return raw;
    if (request.body === undefined || request.body === null) return Buffer.alloc(0);
    this.logger.error(
      'The raw body of a webhook request was not kept; the raw-body tap is not installed (configureApp).',
    );
    throw new AppError('INTERNAL_ERROR', { detail: 'The webhook body cannot be verified.' });
  }

  /** A delivery that ends in a 5xx was not processed: forget the event so the gateway's retry is not taken for a repeat. */
  private releaseWhenServerFails(context: ExecutionContext, gateway: string, eventId: string): void {
    const reply = context.switchToHttp().getResponse<FastifyReply | undefined>();
    reply?.raw.once('finish', () => {
      if (reply.statusCode >= 500) void this.ledger.release(gateway, eventId);
    });
  }
}
