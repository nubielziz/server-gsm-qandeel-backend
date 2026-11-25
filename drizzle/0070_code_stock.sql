-- Services sold as codes, and a service's own cost (backend decision 069). Additive: one column and one wider check, written as drizzle-kit
-- generates them (the migration journal runs it once); an API of the release before keeps working on the migrated schema (it never writes the
-- new column, whose default is false, and never writes the new block reason).
--
-- 1. Only a service delivered from code stock holds codes, and only its orders take a code at placement. Until now every service could
--    hold codes and every order tried the stock first.
ALTER TABLE "services" ADD COLUMN "stock_delivery" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- 2. A service that holds any code that is not void (available, reserved or sold) keeps delivering from its stock: it becomes a stock
--    service. A service whose codes were all voided, or that never had one, stays off. Archived services are included (their codes are
--    history; the flag changes nothing for them).
UPDATE "services" s
   SET "stock_delivery" = true,
       "updated_at" = now()
 WHERE NOT s."stock_delivery"
   AND EXISTS (SELECT 1 FROM "inventory_codes" c WHERE c."service_id" = s."id" AND c."status" <> 'void');--> statement-breakpoint
-- 3. A publish row may be blocked `out_of_stock`: an automatic stock service with no usable supplier and no available code. The list only
--    grows, so every stored row passes the new check.
ALTER TABLE "listing_publish_items" DROP CONSTRAINT "listing_publish_items_blocked_reason_check";--> statement-breakpoint
ALTER TABLE "listing_publish_items" ADD CONSTRAINT "listing_publish_items_blocked_reason_check" CHECK ("listing_publish_items"."blocked_reason" in ('already_listed', 'service_disabled', 'category_inactive', 'b2b_only', 'not_orderable', 'supplier_unavailable', 'out_of_stock', 'title_missing', 'title_too_long', 'price_missing', 'below_floor', 'slug_taken'));
