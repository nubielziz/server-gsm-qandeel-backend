// The optional `Idempotency-Key` request header shared by REST v1's placements and the merchant portal's `POST /client/orders` (ALIGNMENT § 7).
import { z } from 'zod';
import { IDEMPOTENCY_WINDOW_DAYS } from '../domain/idempotency-window';

/**
 * The headers schema of a route that accepts `Idempotency-Key`.
 *
 * Why: decision 026 and feature 24B: a retry (or a double click) of a placement must not place or hold twice; the key is optional, 1 to 255
 * printable characters without spaces, and without it the route behaves as it always did.
 */
export const IdempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .trim()
    .min(1)
    .max(255)
    .regex(/^[\x21-\x7e]+$/, 'Use printable characters without spaces.')
    .optional()
    .describe(
      'Makes a retry safe: the first answer is stored with the key and sent again for the same request; another request with the key ' +
        'is `409 IDEMPOTENCY_KEY_REUSED`, one still running `409 IDEMPOTENCY_IN_PROGRESS`. ' +
        `The answer is kept ${IDEMPOTENCY_WINDOW_DAYS} days from the first request; after that the stored answer is gone and the same key places a new order.`,
    ),
});
