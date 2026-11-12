CREATE TABLE "supplier_import_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_import_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"supplier_id" bigint NOT NULL,
	"scope" text NOT NULL,
	"groups" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"service_status" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"created_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"categories_created" integer DEFAULT 0 NOT NULL,
	"created_with_quantity" integer DEFAULT 0 NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"requested_by" bigint,
	"started_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	"heartbeat_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_import_runs_scope_check" CHECK ("supplier_import_runs"."scope" in ('all', 'groups')),
	CONSTRAINT "supplier_import_runs_service_status_check" CHECK ("supplier_import_runs"."service_status" in ('active', 'disabled')),
	CONSTRAINT "supplier_import_runs_status_check" CHECK ("supplier_import_runs"."status" in ('queued', 'running', 'succeeded', 'failed')),
	CONSTRAINT "supplier_import_runs_counts_check" CHECK ("supplier_import_runs"."total" >= 0 and "supplier_import_runs"."created_count" >= 0 and "supplier_import_runs"."skipped_count" >= 0 and "supplier_import_runs"."failed_count" >= 0 and "supplier_import_runs"."categories_created" >= 0 and "supplier_import_runs"."created_with_quantity" >= 0)
);
--> statement-breakpoint
ALTER TABLE "supplier_import_runs" ADD CONSTRAINT "supplier_import_runs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_import_runs" ADD CONSTRAINT "supplier_import_runs_requested_by_staff_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_import_runs_supplier_idx" ON "supplier_import_runs" USING btree ("supplier_id","id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_import_runs_requested_by_idx" ON "supplier_import_runs" USING btree ("requested_by");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_import_runs_active_uq" ON "supplier_import_runs" USING btree ("supplier_id") WHERE "supplier_import_runs"."status" in ('queued', 'running');