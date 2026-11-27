-- Ten more field types (backend decision 076). The owner's order of 2026-11-27: staff choose a check type for a custom field (imei_bulk,
-- imeisv, serial, iccid, eid, meid, ecid, mac_address, mi_lock_code, box_sn) and the server judges the value by its type on every surface.
-- Only the check of service_fields.field_type changes: the two statements drizzle-kit generated from the schema, as they came (the tooling
-- test of the expand migration compares them word for word). No data step: no stored field changes type (0072's rule is not repeated),
-- and no other column, table, cache key or search document is touched.
ALTER TABLE "service_fields" DROP CONSTRAINT "service_fields_field_type_check";--> statement-breakpoint
ALTER TABLE "service_fields" ADD CONSTRAINT "service_fields_field_type_check" CHECK ("service_fields"."field_type" in ('text', 'number', 'select', 'textarea', 'imei', 'imei_bulk', 'imeisv', 'serial', 'iccid', 'eid', 'meid', 'ecid', 'mac_address', 'mi_lock_code', 'box_sn'));