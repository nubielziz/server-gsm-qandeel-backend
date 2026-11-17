ALTER TABLE "service_listings" DROP CONSTRAINT "service_listings_service_locale_uq";--> statement-breakpoint
ALTER TABLE "service_listings" DROP CONSTRAINT "service_listings_slug_uq";--> statement-breakpoint
ALTER TABLE "service_categories" DROP COLUMN "name_ar";--> statement-breakpoint
ALTER TABLE "service_listings" DROP COLUMN "locale";--> statement-breakpoint
ALTER TABLE "service_listings" ADD CONSTRAINT "service_listings_service_uq" UNIQUE("service_id");--> statement-breakpoint
ALTER TABLE "service_listings" ADD CONSTRAINT "service_listings_slug_uq" UNIQUE("slug");