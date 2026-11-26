-- IMEI is a field type (backend decision 073). The owner's order of 2026-11-26: the service type imei no longer forces an IMEI; the IMEI input
-- is the default of an IMEI service and staff are free to change it. A custom field gains the type imei (one IMEI: digits, 15 of them, a valid
-- Luhn check digit), and the IMEI fields that migration 0071 made (and the like) become of that type, so they keep checking the IMEI.
-- Every statement can run twice and on an empty database. Only service_fields is written: its check constraint, and the type of the fields
-- below; every other column, service, table and orders.inputs is not touched.
--
-- 1. The check of field_type takes the new value (drizzle-kit generated these two statements from the schema; IF EXISTS added so the pair
--    can run twice).
ALTER TABLE "service_fields" DROP CONSTRAINT IF EXISTS "service_fields_field_type_check";--> statement-breakpoint
ALTER TABLE "service_fields" ADD CONSTRAINT "service_fields_field_type_check" CHECK ("service_fields"."field_type" in ('text', 'number', 'select', 'textarea', 'imei'));--> statement-breakpoint
-- 2. Every field that is the main input of an IMEI service (whatever its status, archived ones included), is of type text and whose Name is
--    IMEI in any letter case becomes of type imei: the 277 fields 0071 inserted, a supplier field named IMEI that the import or the fields
--    route flagged, and the demo seed's. Its key, Name, label, required tick, pattern, options and place in the form stay. A field of another
--    type or Name, a field that is not the main input and a field of a service of another type are left as they are. btrim as in 0071: Names
--    are stored trimmed since 0068.
UPDATE "service_fields" f
   SET "field_type" = 'imei',
       "updated_at" = now()
  FROM "services" s
 WHERE s."id" = f."service_id"
   AND s."type" = 'imei'
   AND f."is_main_input"
   AND f."field_type" = 'text'
   AND lower(btrim(f."supplier_key")) = 'imei';
-- Not here, on purpose: no outbox event and no cache step. The search index holds no field, and no cached read holds a service's fields
-- (docs/cache-keys.md): the shop's and the portal's service pages and our Dhru list read Postgres on every request.
