-- Feature 7b (merchant API keys and webhooks): webhook_deliveries.event_id is the id of the event in the delivery envelope and in
-- X-GSM-Event-Id; (endpoint_id, event_id) is unique so a repeated fan-out of one event cannot double a delivery to an endpoint.
-- Hand-edited after drizzle-kit: rows that exist before this migration get a stable legacy id, then the column becomes NOT NULL.
ALTER TABLE "webhook_deliveries" ADD COLUMN "event_id" text;--> statement-breakpoint
UPDATE "webhook_deliveries" SET "event_id" = 'evt_legacy_' || "id" WHERE "event_id" IS NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "event_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_event_uq" UNIQUE("endpoint_id","event_id");
