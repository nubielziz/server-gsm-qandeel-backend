CREATE TABLE "retail_price_follows" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "retail_price_follows_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" bigint NOT NULL,
	"rule_id" bigint,
	"applied_price" numeric(18, 4) NOT NULL,
	"applied_cost" numeric(18, 4) NOT NULL,
	"applied_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retail_price_follows_service_uq" UNIQUE("service_id"),
	CONSTRAINT "retail_price_follows_applied_price_check" CHECK ("retail_price_follows"."applied_price" > 0),
	CONSTRAINT "retail_price_follows_applied_cost_check" CHECK ("retail_price_follows"."applied_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "retail_price_rules" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "retail_price_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scope" text NOT NULL,
	"service_type" text,
	"category_id" bigint,
	"percent" numeric(9, 4) NOT NULL,
	"fixed" numeric(18, 4) DEFAULT '0' NOT NULL,
	"rounding" text NOT NULL,
	"round_from" numeric(18, 4) DEFAULT '5' NOT NULL,
	"auto_follow_percent" integer DEFAULT 25 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"updated_by" bigint,
	"changed_at" timestamp (3) with time zone NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retail_price_rules_scope_check" CHECK ("retail_price_rules"."scope" in ('global', 'type', 'category')),
	CONSTRAINT "retail_price_rules_service_type_check" CHECK ("retail_price_rules"."service_type" in ('imei', 'server', 'remote', 'file')),
	CONSTRAINT "retail_price_rules_rounding_check" CHECK ("retail_price_rules"."rounding" in ('cent', 'step_0.05', 'step_0.10', 'ends_99')),
	CONSTRAINT "retail_price_rules_target_check" CHECK (("retail_price_rules"."scope" = 'global' and "retail_price_rules"."service_type" is null and "retail_price_rules"."category_id" is null) or ("retail_price_rules"."scope" = 'type' and "retail_price_rules"."service_type" is not null and "retail_price_rules"."category_id" is null) or ("retail_price_rules"."scope" = 'category' and "retail_price_rules"."service_type" is null and "retail_price_rules"."category_id" is not null)),
	CONSTRAINT "retail_price_rules_percent_check" CHECK ("retail_price_rules"."percent" >= 0 and "retail_price_rules"."percent" <= 1000),
	CONSTRAINT "retail_price_rules_fixed_check" CHECK ("retail_price_rules"."fixed" >= 0 and "retail_price_rules"."fixed" <= 100000),
	CONSTRAINT "retail_price_rules_round_from_check" CHECK ("retail_price_rules"."round_from" >= 0),
	CONSTRAINT "retail_price_rules_auto_follow_check" CHECK ("retail_price_rules"."auto_follow_percent" >= 0 and "retail_price_rules"."auto_follow_percent" <= 1000),
	CONSTRAINT "retail_price_rules_deleted_check" CHECK ("retail_price_rules"."deleted_at" is null or "retail_price_rules"."is_active" = false)
);
--> statement-breakpoint
ALTER TABLE "retail_price_follows" ADD CONSTRAINT "retail_price_follows_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_price_follows" ADD CONSTRAINT "retail_price_follows_rule_id_retail_price_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."retail_price_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_price_rules" ADD CONSTRAINT "retail_price_rules_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_price_rules" ADD CONSTRAINT "retail_price_rules_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retail_price_follows_rule_idx" ON "retail_price_follows" USING btree ("rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "retail_price_rules_global_uq" ON "retail_price_rules" USING btree ("scope") WHERE "retail_price_rules"."scope" = 'global' and "retail_price_rules"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_price_rules_type_uq" ON "retail_price_rules" USING btree ("service_type") WHERE "retail_price_rules"."scope" = 'type' and "retail_price_rules"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_price_rules_category_uq" ON "retail_price_rules" USING btree ("category_id") WHERE "retail_price_rules"."scope" = 'category' and "retail_price_rules"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "retail_price_rules_category_idx" ON "retail_price_rules" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "retail_price_rules_updated_by_idx" ON "retail_price_rules" USING btree ("updated_by");