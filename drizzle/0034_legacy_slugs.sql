CREATE TABLE "legacy_slugs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "legacy_slugs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"service_id" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_slugs_kind_slug_uq" UNIQUE("kind","slug"),
	CONSTRAINT "legacy_slugs_kind_check" CHECK ("legacy_slugs"."kind" in ('service', 'page', 'help')),
	CONSTRAINT "legacy_slugs_service_check" CHECK ("legacy_slugs"."service_id" is null or "legacy_slugs"."kind" = 'service')
);
--> statement-breakpoint
ALTER TABLE "legacy_slugs" ADD CONSTRAINT "legacy_slugs_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_slugs_service_id_idx" ON "legacy_slugs" USING btree ("service_id");