// The registry of incoming gateway webhook verifiers (decisions 018, 019): one adapter per payment gateway checks that gateway's
// signature scheme; the guard around it adds the timestamp window and the event-id de-duplication that every gateway shares.
import type { IncomingHttpHeaders } from 'node:http';
import { Injectable } from '@nestjs/common';

/** A gateway slug as it appears in `/webhooks/payments/:gateway`: lower case letters, digits, `_` and `-`. */
export const GATEWAY_SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * One webhook delivery, as an adapter sees it.
 *
 * Why: signatures cover the exact bytes the gateway sent, so the adapter gets the raw body, not a parsed object.
 */
export interface WebhookDelivery {
  /** The gateway slug of the URL. */
  readonly gateway: string;
  /** The request headers (names in lower case). */
  readonly headers: IncomingHttpHeaders;
  /** The exact bytes of the body; empty when the request had none. */
  readonly rawBody: Buffer;
  /** The current time in unix seconds, for adapters whose scheme has its own freshness rule. */
  readonly nowSeconds: number;
}

/**
 * What an adapter learned from a delivery whose signature is valid.
 *
 * Why: the guard needs the signed time for the window and the gateway's event id for the replay filter. Both must come from
 * the signed material, never from an unsigned header.
 */
export interface VerifiedDelivery {
  /** The gateway's id of the event (1 to 256 characters). The same event sent again has the same id. */
  readonly eventId: string;
  /**
   * When the gateway signed it, in unix seconds. A scheme that signs no time uses the event's own creation time inside the
   * signed body; a gateway with neither is protected by the event id alone and returns `nowSeconds`.
   */
  readonly timestamp: number;
}

/**
 * Checks one gateway's webhook signature.
 *
 * Why: every gateway signs differently (header names, HMAC input, a public key, a call back to the gateway). Billing writes
 * the adapters (feature 8) and registers them; the window and the replay filter are not repeated in each of them.
 */
export interface WebhookVerifier {
  /** The gateway slug this adapter serves (`stripe`, `wise`). */
  readonly gateway: string;
  /**
   * Verifies the signature of a delivery.
   *
   * @param delivery the gateway, the headers, the raw body and the clock
   * @returns the event id and the signed time of a delivery whose signature is valid
   * @throws {AppError} `WEBHOOK_SIGNATURE_INVALID` (400) when the signature is missing, malformed or wrong, or the gateway is
   *   not configured for webhooks. Any other error is a failure of the adapter and answers `5xx`.
   */
  verify(delivery: WebhookDelivery): Promise<VerifiedDelivery> | VerifiedDelivery;
}

/**
 * The webhook verifiers, by gateway.
 *
 * Why: P2.5c builds the guard and this registry; billing registers one adapter per gateway in `onModuleInit` (feature 8). A
 * gateway without an adapter refuses every delivery.
 */
@Injectable()
export class WebhookVerifiers {
  private readonly verifiers = new Map<string, WebhookVerifier>();

  /**
   * Adds the adapter of a gateway.
   *
   * @param verifier the adapter
   * @throws {Error} when the slug is not valid or already has an adapter (a boot-time programming error)
   */
  register(verifier: WebhookVerifier): void {
    if (!GATEWAY_SLUG.test(verifier.gateway)) {
      throw new Error(`"${verifier.gateway}" is not a valid gateway slug (lower case letters, digits, "_" and "-")`);
    }
    if (this.verifiers.has(verifier.gateway)) {
      throw new Error(`A webhook verifier for "${verifier.gateway}" is already registered`);
    }
    this.verifiers.set(verifier.gateway, verifier);
  }

  /**
   * Finds the adapter of a gateway.
   *
   * @param gateway the slug from the URL
   * @returns the adapter, or `undefined` for an unknown slug
   */
  get(gateway: string): WebhookVerifier | undefined {
    return GATEWAY_SLUG.test(gateway) ? this.verifiers.get(gateway) : undefined;
  }

  /**
   * Lists the gateways that have an adapter.
   *
   * @returns the slugs, sorted
   */
  gateways(): string[] {
    return [...this.verifiers.keys()].sort();
  }
}
