CREATE TABLE "notification_campaigns" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_campaigns_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"audience" jsonb NOT NULL,
	"content" jsonb NOT NULL,
	"link" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_at" timestamp (3) with time zone,
	"queued_at" timestamp (3) with time zone,
	"started_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	"cancelled_at" timestamp (3) with time zone,
	"expected_recipients" integer,
	"recipients" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fanout_cursor" jsonb,
	"chunks_done" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_by" bigint NOT NULL,
	"updated_by" bigint,
	"cancelled_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_campaigns_status_check" CHECK ("notification_campaigns"."status" in ('draft', 'scheduled', 'queued', 'sending', 'sent', 'cancelled', 'failed')),
	CONSTRAINT "notification_campaigns_purpose_check" CHECK ("notification_campaigns"."purpose" in ('service', 'marketing')),
	CONSTRAINT "notification_campaigns_channels_check" CHECK ("notification_campaigns"."channels" <@ array['in_app','email','telegram']::text[] and cardinality("notification_campaigns"."channels") > 0)
);
--> statement-breakpoint
CREATE TABLE "notification_inbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_inbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recipient_type" text NOT NULL,
	"recipient_id" bigint NOT NULL,
	"campaign_id" bigint,
	"event" text,
	"category" text NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read_at" timestamp (3) with time zone,
	"dedupe_key" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_inbox_recipient_type_check" CHECK ("notification_inbox"."recipient_type" in ('staff', 'client', 'customer')),
	CONSTRAINT "notification_inbox_category_check" CHECK ("notification_inbox"."category" in ('announcement', 'marketing', 'order', 'payment', 'wallet', 'billing', 'support', 'account', 'alert')),
	CONSTRAINT "notification_inbox_source_check" CHECK (("notification_inbox"."campaign_id" is not null) <> ("notification_inbox"."event" is not null))
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "campaign_id" bigint;--> statement-breakpoint
ALTER TABLE "notification_campaigns" ADD CONSTRAINT "notification_campaigns_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_campaigns" ADD CONSTRAINT "notification_campaigns_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_campaigns" ADD CONSTRAINT "notification_campaigns_cancelled_by_staff_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_inbox" ADD CONSTRAINT "notification_inbox_campaign_id_notification_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."notification_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_campaigns_due_idx" ON "notification_campaigns" USING btree ("scheduled_at") WHERE "notification_campaigns"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "notification_campaigns_status_idx" ON "notification_campaigns" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "notification_campaigns_created_idx" ON "notification_campaigns" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_campaigns_created_by_idx" ON "notification_campaigns" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "notification_campaigns_updated_by_idx" ON "notification_campaigns" USING btree ("updated_by");--> statement-breakpoint
CREATE INDEX "notification_campaigns_cancelled_by_idx" ON "notification_campaigns" USING btree ("cancelled_by");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_inbox_campaign_recipient_uq" ON "notification_inbox" USING btree ("campaign_id","recipient_type","recipient_id") WHERE "notification_inbox"."campaign_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_inbox_dedupe_key_uq" ON "notification_inbox" USING btree ("dedupe_key") WHERE "notification_inbox"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "notification_inbox_recipient_idx" ON "notification_inbox" USING btree ("recipient_type","recipient_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_inbox_unread_idx" ON "notification_inbox" USING btree ("recipient_type","recipient_id") WHERE "notification_inbox"."read_at" is null;--> statement-breakpoint
CREATE INDEX "notification_inbox_campaign_id_idx" ON "notification_inbox" USING btree ("campaign_id","read_at");--> statement-breakpoint
CREATE INDEX "notification_inbox_created_idx" ON "notification_inbox" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notification_inbox_read_idx" ON "notification_inbox" USING btree ("read_at") WHERE "notification_inbox"."read_at" is not null;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_campaign_id_notification_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."notification_campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notifications_campaign_idx" ON "notifications" USING btree ("campaign_id","channel","status");--> statement-breakpoint
CREATE INDEX "notifications_campaign_list_idx" ON "notifications" USING btree ("campaign_id","channel","id") WHERE "notifications"."campaign_id" is not null;