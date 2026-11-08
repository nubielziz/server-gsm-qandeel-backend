-- Feature 12b (alerts and integrity): one open alert per rule and subject (`subject_key`, with existing rows backfilled
-- before the unique index), and `alert_streaks`, when each rule's breach or recovery started (a gauge fires and resolves only
-- after its whole window). Renumbered at the merges (0011/0012 joined, then 0014).
--> statement-breakpoint
CREATE TABLE "alert_streaks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alert_streaks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"rule_id" bigint NOT NULL,
	"subject_key" text NOT NULL,
	"kind" text NOT NULL,
	"condition" text NOT NULL,
	"since" timestamp (3) with time zone NOT NULL,
	"seen_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_streaks_rule_subject_uq" UNIQUE("rule_id","subject_key"),
	CONSTRAINT "alert_streaks_kind_check" CHECK ("alert_streaks"."kind" in ('breach', 'clear'))
);
--> statement-breakpoint
ALTER TABLE "alert_events" ADD COLUMN "subject_label" text;--> statement-breakpoint
ALTER TABLE "alert_events" ADD COLUMN "subject_key" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
UPDATE "alert_events" SET "subject_key" = CASE WHEN "subject_id" IS NULL THEN "subject_type" ELSE "subject_type" || ':' || "subject_id" END;--> statement-breakpoint
ALTER TABLE "alert_streaks" ADD CONSTRAINT "alert_streaks_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alert_events_open_uq" ON "alert_events" USING btree ("rule_id","subject_key") WHERE "alert_events"."status" <> 'resolved';