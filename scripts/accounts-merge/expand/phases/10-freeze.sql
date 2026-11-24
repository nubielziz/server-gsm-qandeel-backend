-- Phase 10 of the expand migration of one account type (backend decision 064): the old customer tables are frozen. Nothing reads or writes
-- them after this release; a write that still reaches them is a bug and is refused with the constraint <table>_retired. TRUNCATE (the
-- test reset) does not fire row triggers. The contract release drops both tables and this function.
CREATE OR REPLACE FUNCTION "forbid_retired_write"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is retired: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_retired';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "customers_retired" ON "customers";
CREATE TRIGGER "customers_retired" BEFORE INSERT OR UPDATE OR DELETE ON "customers"
  FOR EACH ROW EXECUTE FUNCTION "forbid_retired_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "customer_credentials_retired" ON "customer_credentials";
CREATE TRIGGER "customer_credentials_retired" BEFORE INSERT OR UPDATE OR DELETE ON "customer_credentials"
  FOR EACH ROW EXECUTE FUNCTION "forbid_retired_write"();
--> statement-breakpoint
-- The approvals were read by phases 0 and 2 and are spent: a later run of the check script starts from no approval.
DELETE FROM "settings" WHERE "key" = 'accountsMerge.approvedPairs';
