-- Feature 41 (decision 051): two data steps, both safe on existing rows.
-- 1. The hint of a supplier's API key showed the key's first characters. A key cannot be read in SQL, so every stored hint becomes the
--    mask alone; a key saved again gets the new hint (the mask, and the key's last 2 characters when it has 16 or more).
-- 2. Field patterns are now accepted only in a form that is checked before it runs. The check is application code, so this migration only
--    asks for one review: the worker's relay turns this row into the job `field_patterns_review` (`FieldPatternReview`), which clears each
--    stored pattern outside that form with an audit row and a warning. The event type is `FIELD_PATTERNS_REVIEW_EVENT`; a test keeps the two
--    equal.
UPDATE "suppliers" SET "api_key_hint" = '••••' WHERE "api_key_hint" IS NOT NULL AND "api_key_hint" <> '••••';
--> statement-breakpoint
INSERT INTO "outbox_events" ("type", "aggregate_type", "aggregate_id", "payload")
VALUES ('catalog.field_patterns_review', 'service_fields', 1, '{"meta": {}}'::jsonb);
