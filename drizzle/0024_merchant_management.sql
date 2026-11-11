ALTER TABLE "api_keys" ADD COLUMN "created_by" bigint;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "last_login_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "last_login_ip" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "tax_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "internal_notes" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_created_by_idx" ON "api_keys" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_locale_check" CHECK ("clients"."locale" in ('en', 'ar'));