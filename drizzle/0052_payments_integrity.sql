-- Decision 048: one order per checkout session is a database rule, not only a row lock. The check stops the migration and names the sessions
-- when existing rows break the rule; docs/OPERATIONS.md ("One order per checkout session") says what to do. Nothing is changed when it stops.
-- The unique index is a full one: it also serves the foreign key's checks, and NULLs stay distinct (orders without a checkout session).
-- check:begin
DO $$
DECLARE
  sessions text;
BEGIN
  SELECT string_agg(checkout_session_id::text, ', ' ORDER BY checkout_session_id) INTO sessions
  FROM (
    SELECT checkout_session_id FROM orders WHERE checkout_session_id IS NOT NULL
    GROUP BY checkout_session_id HAVING count(*) > 1
    ORDER BY checkout_session_id LIMIT 20
  ) AS duplicated;
  IF sessions IS NOT NULL THEN
    RAISE EXCEPTION 'orders_checkout_session_uq: checkout sessions with more than one order: %. Keep the order each session names (checkout_sessions.order_id), clear checkout_session_id on the other orders, then migrate again (docs/OPERATIONS.md).', sessions;
  END IF;
END $$;
-- check:end
--> statement-breakpoint
CREATE UNIQUE INDEX "orders_checkout_session_uq" ON "orders" USING btree ("checkout_session_id");--> statement-breakpoint
DROP INDEX "orders_checkout_session_id_idx";
