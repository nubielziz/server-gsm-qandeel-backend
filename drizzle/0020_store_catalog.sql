ALTER TABLE "service_categories" ADD COLUMN "name_ar" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_listings" ADD COLUMN "listed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "service_listings" ADD COLUMN "sales_30d" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "service_listings" ADD COLUMN "image_file_id" bigint;--> statement-breakpoint
ALTER TABLE "service_listings" ADD CONSTRAINT "service_listings_image_file_id_files_id_fk" FOREIGN KEY ("image_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_listings_image_file_id_idx" ON "service_listings" USING btree ("image_file_id");