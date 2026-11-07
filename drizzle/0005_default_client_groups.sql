-- Feature 4a (catalog-structure): a default merchant group and the storefront retail group always exist.
-- A fresh database had no client_groups row, so POST /client/auth/register and POST /admin/clients answered 500
-- ("No default merchant group is configured.") until staff created and marked a group. This data migration adds what is
-- missing and changes nothing else; it is safe to run on a database that already has groups.
--   * No default group but a merchant group exists: the first one by sort and id becomes the default.
--   * No merchant group at all: "Standard" is inserted as the default (no discount, never a promotion target, no deposit
--     limit, no overdraft; a name that is taken falls back to "Default merchant group").
--   * No storefront retail group (kind b2c_retail): "Storefront retail" is inserted (a taken name gets " (storefront)").
-- The seed's demo groups reuse these rows by name or replace them (scripts/seed/identity.ts).
DO $$
DECLARE
  next_sort integer;
  chosen_name text;
BEGIN
  SELECT coalesce(max("sort"), 0) + 1 INTO next_sort FROM "client_groups";

  IF NOT EXISTS (SELECT 1 FROM "client_groups" WHERE "is_default") THEN
    IF EXISTS (SELECT 1 FROM "client_groups" WHERE "kind" = 'b2b') THEN
      UPDATE "client_groups" SET "is_default" = true
      WHERE "id" = (SELECT "id" FROM "client_groups" WHERE "kind" = 'b2b' ORDER BY "sort", "id" LIMIT 1);
    ELSE
      chosen_name := 'Standard';
      IF EXISTS (SELECT 1 FROM "client_groups" WHERE lower("name") = lower(chosen_name)) THEN
        chosen_name := 'Default merchant group';
      END IF;
      INSERT INTO "client_groups"
        ("name", "kind", "discount_percent", "is_default", "earn_threshold", "deposit_limit", "overdraft_allowed", "sort")
      VALUES (chosen_name, 'b2b', 0, true, 0, 0, false, next_sort);
      next_sort := next_sort + 1;
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM "client_groups" WHERE "kind" = 'b2c_retail') THEN
    chosen_name := 'Storefront retail';
    IF EXISTS (SELECT 1 FROM "client_groups" WHERE lower("name") = lower(chosen_name)) THEN
      chosen_name := 'Storefront retail (storefront)';
    END IF;
    INSERT INTO "client_groups"
      ("name", "kind", "discount_percent", "is_default", "earn_threshold", "deposit_limit", "overdraft_allowed", "sort")
    VALUES (chosen_name, 'b2c_retail', 0, false, 0, 0, false, next_sort);
  END IF;
END
$$;
