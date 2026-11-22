-- Feature 44 (decision 054): the shop's link tokens written before this release are still stored as issued. Their keyed hash and encrypted
-- copy need the application's keys, so this migration only asks for the work once: the worker's relay turns each row into the seal job
-- of the module that owns the table (checkout_tokens_seal, tracking_tokens_seal, ticket_tokens_seal on the maintenance queue). Each job
-- converts its rows one by one and records a job_runs row. The event types are the constants of the three passes; a test keeps them equal.
INSERT INTO "outbox_events" ("type", "aggregate_type", "aggregate_id", "payload")
VALUES
  ('customers.checkout_tokens_seal', 'checkout_sessions', 1, '{"meta": {}}'::jsonb),
  ('orders.tracking_tokens_seal', 'orders', 1, '{"meta": {}}'::jsonb),
  ('support.ticket_tokens_seal', 'support_tickets', 1, '{"meta": {}}'::jsonb);
