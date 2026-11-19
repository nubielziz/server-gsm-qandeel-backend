ALTER TABLE "service_supplier_links" ADD COLUMN "import_run_id" bigint;--> statement-breakpoint
ALTER TABLE "supplier_import_runs" ADD COLUMN "publish_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "service_supplier_links" ADD CONSTRAINT "service_supplier_links_import_run_id_supplier_import_runs_id_fk" FOREIGN KEY ("import_run_id") REFERENCES "public"."supplier_import_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_supplier_links_import_run_idx" ON "service_supplier_links" USING btree ("import_run_id");--> statement-breakpoint
ALTER TABLE "supplier_import_runs" ADD CONSTRAINT "supplier_import_runs_publish_mode_check" CHECK ("supplier_import_runs"."publish_mode" in ('none', 'listed', 'unlisted'));