-- A plain IMEI service gets an IMEI field (backend decision 071). Since decision 070 the order forms draw only a service's custom fields and
-- an IMEI service's IMEI is typed into the field flagged is_main_input; a Dhru supplier never lists the IMEI among its fields (it travels as
-- the IMEI parameter), so most imported IMEI services had no such field and the shop could not order them. Hand-written data steps, additive:
-- no table, column, index or check changes, every statement can run twice and on an empty database, and an API of the release before keeps
-- working on the migrated data (it already takes the flagged field of an IMEI service as its IMEI, decision 070). Only service_fields is
-- written, and only for services of type imei, whatever their status, that have no flagged field: a service that has one, a service of
-- another type, orders.inputs and every other table are not touched.
--
-- 1. A field whose Name is IMEI in any letter case is the IMEI itself (decision 065): the first such field by (sort, id) is flagged and
--    nothing is inserted. btrim removes spaces only where the code trims all whitespace: Names are stored trimmed since 0068, so they agree.
UPDATE "service_fields" f
   SET "is_main_input" = true,
       "updated_at" = now()
  FROM (SELECT DISTINCT ON (sf."service_id") sf."id"
          FROM "service_fields" sf
          JOIN "services" s ON s."id" = sf."service_id"
         WHERE s."type" = 'imei'
           AND lower(btrim(sf."supplier_key")) = 'imei'
           AND NOT EXISTS (SELECT 1 FROM "service_fields" o WHERE o."service_id" = sf."service_id" AND o."is_main_input")
         ORDER BY sf."service_id", sf."sort", sf."id") m
 WHERE f."id" = m."id";--> statement-breakpoint
-- 2. Every other IMEI service without a flagged field gets one, first in the form: key imei (else the first of imei_2, imei_3, ... that the
--    service does not use), Name and label IMEI, required text, no pattern, no options, sort 0. Its own fields move down by one and keep
--    their order. One statement, so the move and the insert never happen apart; a service with a field named IMEI is left to step 1.
WITH "target" AS (
  SELECT s."id"
    FROM "services" s
   WHERE s."type" = 'imei'
     AND NOT EXISTS (SELECT 1 FROM "service_fields" o WHERE o."service_id" = s."id" AND o."is_main_input")
     AND NOT EXISTS (SELECT 1 FROM "service_fields" o WHERE o."service_id" = s."id" AND lower(btrim(o."supplier_key")) = 'imei')
), "moved" AS (
  UPDATE "service_fields" f
     SET "sort" = f."sort" + 1,
         "updated_at" = now()
    FROM "target" t
   WHERE f."service_id" = t."id"
)
INSERT INTO "service_fields" ("service_id", "key", "label", "field_type", "options", "required", "regex", "supplier_key", "is_main_input", "sort")
SELECT t."id", k."key", 'IMEI', 'text', '{}'::text[], true, '', 'IMEI', true, 0
  FROM "target" t
  CROSS JOIN LATERAL (
    SELECT c."key"
      FROM (SELECT n, CASE WHEN n = 1 THEN 'imei' ELSE 'imei_' || n END AS "key"
              FROM generate_series(1, (SELECT count(*)::int + 1 FROM "service_fields" x WHERE x."service_id" = t."id")) AS n) c
     WHERE NOT EXISTS (SELECT 1 FROM "service_fields" x WHERE x."service_id" = t."id" AND x."key" = c."key")
     ORDER BY c.n
     LIMIT 1
  ) k;
-- Not here, on purpose: no outbox event and no cache step. The search index holds no field, and no cached read holds a service's fields
-- (docs/cache-keys.md): the shop's and the portal's service pages and our Dhru list read Postgres on every request.
