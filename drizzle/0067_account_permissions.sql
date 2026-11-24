-- The stored roles of one account type (backend decision 064): one permission family, clients:*, now covers merchants and customers
-- alike, and customers:privacy stays for data requests, exports and erasure. Data only; safe on an empty database and safe to run twice
-- (each update skips a role that already holds what it adds). Roles that grant "*" are never touched.
--
-- 1. The guard: a role that holds the two old families unevenly (customers:read without clients:read, customers:password without
--    clients:security, customers:* without clients:*, clients:update and clients:security without customers:suspend, ...) would gain or
--    lose rights when the customer routes start to read the clients permissions (a retail suspension needs clients:update and
--    clients:security from now on). It stops the migration (one transaction: nothing changes) and names every such role, so staff align
--    it first.
--    "Holds" is the grammar of the permission check: the exact permission, its area with "*", or "*".
DO $$
DECLARE
  uneven text;
BEGIN
  SELECT string_agg(format('%s (%s)', r."id", r."name"), ', ' ORDER BY r."id") INTO uneven
    FROM "roles" r
   CROSS JOIN LATERAL (
     SELECT 'customers:*' = ANY (r."permissions") AS customers_all,
            'clients:*' = ANY (r."permissions") AS clients_all
   ) AS area
   CROSS JOIN LATERAL (
     SELECT area.customers_all OR 'customers:read' = ANY (r."permissions") AS customers_read,
            area.customers_all OR 'customers:create' = ANY (r."permissions") AS customers_create,
            area.customers_all OR 'customers:update' = ANY (r."permissions") AS customers_update,
            area.customers_all OR 'customers:password' = ANY (r."permissions") AS customers_password,
            area.customers_all OR 'customers:suspend' = ANY (r."permissions") AS customers_suspend,
            area.customers_all OR 'customers:block' = ANY (r."permissions") AS customers_block,
            area.clients_all OR 'clients:read' = ANY (r."permissions") AS clients_read,
            area.clients_all OR 'clients:create' = ANY (r."permissions") AS clients_create,
            area.clients_all OR 'clients:update' = ANY (r."permissions") AS clients_update,
            area.clients_all OR 'clients:security' = ANY (r."permissions") AS clients_security
   ) AS held
   WHERE NOT ('*' = ANY (r."permissions"))
     AND (held.customers_read <> held.clients_read
          OR held.customers_create <> held.clients_create
          OR held.customers_update <> held.clients_update
          OR held.customers_password <> held.clients_security
          OR (held.customers_suspend AND NOT (held.clients_update AND held.clients_security))
          OR (held.clients_update AND held.clients_security AND NOT held.customers_suspend)
          OR (held.customers_block AND NOT held.clients_security)
          OR (area.customers_all AND NOT area.clients_all));
  IF uneven IS NOT NULL THEN
    RAISE EXCEPTION 'Roles hold merchant and customer permissions differently; change them in Admins and access before this release: %', uneven
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_permissions_guard';
  END IF;
END
$$;
--> statement-breakpoint
-- 2. Blocking an account is its own action now (clients:block): a role that could block a customer keeps that right. The new entry is
--    appended; the other entries keep their order.
UPDATE "roles"
   SET "permissions" = array_append("permissions", 'clients:block'),
       "updated_at" = now()
 WHERE NOT ('*' = ANY ("permissions"))
   AND ('customers:block' = ANY ("permissions") OR 'customers:*' = ANY ("permissions"))
   AND NOT ('clients:block' = ANY ("permissions") OR 'clients:*' = ANY ("permissions"));
--> statement-breakpoint
-- 3. customers:privacy is the one customer permission that stays; a role that held it only through customers:* gets it by name, so it
--    keeps the right when the contract release removes the retired customer entries.
UPDATE "roles"
   SET "permissions" = array_append("permissions", 'customers:privacy'),
       "updated_at" = now()
 WHERE NOT ('*' = ANY ("permissions"))
   AND 'customers:*' = ANY ("permissions")
   AND NOT ('customers:privacy' = ANY ("permissions"));
