CREATE TABLE "listing_publish_items" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "listing_publish_items_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" bigint NOT NULL,
	"service_id" bigint NOT NULL,
	"detected" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"slug" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"carrier" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"slug_source" text DEFAULT 'auto' NOT NULL,
	"price_mode" text DEFAULT 'rule' NOT NULL,
	"price_override" numeric(18, 4),
	"replaces_price" numeric(18, 4),
	"existing_price" numeric(18, 4),
	"cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"floor_price" numeric(18, 4) DEFAULT '0' NOT NULL,
	"rule_id" bigint,
	"rule_price" numeric(18, 4),
	"state" text DEFAULT 'blocked' NOT NULL,
	"blocked_reason" text,
	"flags" text[] DEFAULT '{}' NOT NULL,
	"included" boolean DEFAULT false NOT NULL,
	"edited" boolean DEFAULT false NOT NULL,
	"evaluated_at" timestamp (3) with time zone,
	"result" text,
	"result_reason" text,
	"result_detail" text,
	"listing_id" bigint,
	"published_price" numeric(18, 4),
	"finished_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_publish_items_run_service_uq" UNIQUE("run_id","service_id"),
	CONSTRAINT "listing_publish_items_slug_source_check" CHECK ("listing_publish_items"."slug_source" in ('auto', 'staff')),
	CONSTRAINT "listing_publish_items_price_mode_check" CHECK ("listing_publish_items"."price_mode" in ('rule', 'manual', 'keep')),
	CONSTRAINT "listing_publish_items_state_check" CHECK ("listing_publish_items"."state" in ('ready', 'review', 'blocked')),
	CONSTRAINT "listing_publish_items_blocked_reason_check" CHECK ("listing_publish_items"."blocked_reason" in ('already_listed', 'service_disabled', 'category_inactive', 'b2b_only', 'not_orderable', 'supplier_unavailable', 'title_missing', 'title_too_long', 'price_missing', 'below_floor', 'slug_taken')),
	CONSTRAINT "listing_publish_items_result_check" CHECK ("listing_publish_items"."result" in ('published', 'skipped', 'refused')),
	CONSTRAINT "listing_publish_items_override_check" CHECK (("listing_publish_items"."price_mode" = 'manual') = ("listing_publish_items"."price_override" is not null) and ("listing_publish_items"."price_override" is null or "listing_publish_items"."price_override" > 0)),
	CONSTRAINT "listing_publish_items_replaces_check" CHECK ("listing_publish_items"."replaces_price" is null or "listing_publish_items"."price_mode" = 'rule'),
	CONSTRAINT "listing_publish_items_included_check" CHECK ("listing_publish_items"."state" <> 'blocked' or "listing_publish_items"."included" = false)
);
--> statement-breakpoint
CREATE TABLE "listing_publish_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "listing_publish_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"status" text DEFAULT 'preparing' NOT NULL,
	"source" text NOT NULL,
	"source_run_id" bigint,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"replaced_by_run_id" bigint,
	"listed" boolean DEFAULT true NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"rules_version" integer NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"published_count" integer DEFAULT 0 NOT NULL,
	"skipped_count" integer DEFAULT 0 NOT NULL,
	"refused_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"requested_by" bigint,
	"attempt" integer DEFAULT 0 NOT NULL,
	"prepare_claimed_at" timestamp (3) with time zone,
	"prepared_at" timestamp (3) with time zone,
	"started_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	"heartbeat_at" timestamp (3) with time zone NOT NULL,
	"switch_status" text,
	"switch_listed" boolean,
	"switched_count" integer DEFAULT 0 NOT NULL,
	"switch_skipped_count" integer DEFAULT 0 NOT NULL,
	"switch_error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listing_publish_runs_status_check" CHECK ("listing_publish_runs"."status" in ('preparing', 'draft', 'queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "listing_publish_runs_source_check" CHECK ("listing_publish_runs"."source" in ('console', 'quick_add')),
	CONSTRAINT "listing_publish_runs_switch_status_check" CHECK ("listing_publish_runs"."switch_status" in ('queued', 'running', 'done', 'failed')),
	CONSTRAINT "listing_publish_runs_switch_check" CHECK (("listing_publish_runs"."switch_status" is null) = ("listing_publish_runs"."switch_listed" is null)),
	CONSTRAINT "listing_publish_runs_counts_check" CHECK ("listing_publish_runs"."total" >= 0 and "listing_publish_runs"."published_count" >= 0 and "listing_publish_runs"."skipped_count" >= 0 and "listing_publish_runs"."refused_count" >= 0 and "listing_publish_runs"."attempt" >= 0 and "listing_publish_runs"."switched_count" >= 0 and "listing_publish_runs"."switch_skipped_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "listing_publish_items" ADD CONSTRAINT "listing_publish_items_run_id_listing_publish_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."listing_publish_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_publish_items" ADD CONSTRAINT "listing_publish_items_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_publish_items" ADD CONSTRAINT "listing_publish_items_rule_id_retail_price_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."retail_price_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_publish_items" ADD CONSTRAINT "listing_publish_items_listing_id_service_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."service_listings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_publish_runs" ADD CONSTRAINT "listing_publish_runs_requested_by_staff_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_publish_items_run_idx" ON "listing_publish_items" USING btree ("run_id","id");--> statement-breakpoint
CREATE INDEX "listing_publish_items_run_state_idx" ON "listing_publish_items" USING btree ("run_id","state");--> statement-breakpoint
CREATE INDEX "listing_publish_items_run_result_idx" ON "listing_publish_items" USING btree ("run_id","result");--> statement-breakpoint
CREATE INDEX "listing_publish_items_service_idx" ON "listing_publish_items" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "listing_publish_items_listing_idx" ON "listing_publish_items" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "listing_publish_items_rule_idx" ON "listing_publish_items" USING btree ("rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_publish_runs_source_run_uq" ON "listing_publish_runs" USING btree ("source_run_id") WHERE "listing_publish_runs"."source_run_id" is not null;--> statement-breakpoint
CREATE INDEX "listing_publish_runs_status_idx" ON "listing_publish_runs" USING btree ("status","id");--> statement-breakpoint
CREATE INDEX "listing_publish_runs_requested_by_idx" ON "listing_publish_runs" USING btree ("requested_by");