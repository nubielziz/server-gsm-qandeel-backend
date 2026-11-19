CREATE TABLE "retail_price_changes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "retail_price_changes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" bigint NOT NULL,
	"rule_id" bigint,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"old_price" numeric(18, 4) NOT NULL,
	"new_price" numeric(18, 4),
	"old_cost" numeric(18, 4) NOT NULL,
	"new_cost" numeric(18, 4) NOT NULL,
	"resolution" text,
	"resolved_at" timestamp (3) with time zone,
	"resolved_by" bigint,
	"notified_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retail_price_changes_kind_check" CHECK ("retail_price_changes"."kind" in ('followed', 'proposed', 'detached')),
	CONSTRAINT "retail_price_changes_reason_check" CHECK ("retail_price_changes"."reason" in ('cost_changed', 'rule_changed', 'floor_changed', 'cost_jump', 'no_cost', 'changed_elsewhere')),
	CONSTRAINT "retail_price_changes_resolution_value_check" CHECK ("retail_price_changes"."resolution" in ('applied', 'kept', 'superseded')),
	CONSTRAINT "retail_price_changes_resolution_check" CHECK (("retail_price_changes"."resolution" is null) = ("retail_price_changes"."resolved_at" is null) and ("retail_price_changes"."resolution" is null or "retail_price_changes"."kind" = 'proposed'))
);
--> statement-breakpoint
ALTER TABLE "retail_price_changes" ADD CONSTRAINT "retail_price_changes_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_price_changes" ADD CONSTRAINT "retail_price_changes_rule_id_retail_price_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."retail_price_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retail_price_changes" ADD CONSTRAINT "retail_price_changes_resolved_by_staff_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retail_price_changes_open_uq" ON "retail_price_changes" USING btree ("service_id") WHERE "retail_price_changes"."kind" = 'proposed' and "retail_price_changes"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "retail_price_changes_kind_idx" ON "retail_price_changes" USING btree ("kind","resolved_at");--> statement-breakpoint
CREATE INDEX "retail_price_changes_service_idx" ON "retail_price_changes" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "retail_price_changes_rule_idx" ON "retail_price_changes" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "retail_price_changes_resolved_by_idx" ON "retail_price_changes" USING btree ("resolved_by");--> statement-breakpoint
CREATE INDEX "retail_price_changes_unnotified_idx" ON "retail_price_changes" USING btree ("id") WHERE "retail_price_changes"."notified_at" is null;