-- refunds.unanswered_send_at: the start of the first send under the refund's current idempotency key that got no answer from the payment
-- gateway (a timeout, a 5xx, a lost send job); the retry and the send job refuse to send under that key once it is more than 20 hours old.
-- NULL for every refund that exists: none has such a send on record, so each keeps the retry it has today.
ALTER TABLE "refunds" ADD COLUMN "unanswered_send_at" timestamp (3) with time zone;
