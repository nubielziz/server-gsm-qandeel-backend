-- Feature 29 (storefront search on Typesense, decision 038): the search's own tables, owned by storefront (additionalTables).
--   * search_synonyms, search_pins, search_hidden_terms: the console's search settings (pushed whole to Typesense by the worker).
--   * search_terms_daily: searches per day and term (counts and a distinct-visitor estimate; no IP, user, session or cookie).
--   * search_index_state: one row (singleton) the worker writes and GET /admin/search/index reads.
--   * the owner's five starting synonyms (plan section 4.6, owner question 6).
CREATE TABLE "search_hidden_terms" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_hidden_terms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"term" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_hidden_terms_term_uq" UNIQUE("term")
);
--> statement-breakpoint
CREATE TABLE "search_index_state" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_index_state_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"singleton" boolean DEFAULT true NOT NULL,
	"schema_version" integer DEFAULT 0 NOT NULL,
	"services_collection" text,
	"terms_collection" text,
	"documents" integer DEFAULT 0 NOT NULL,
	"engine_version" text,
	"memory_bytes" bigint,
	"last_sync_at" timestamp (3) with time zone,
	"last_reconcile_at" timestamp (3) with time zone,
	"last_rebuild_at" timestamp (3) with time zone,
	"last_terms_build_at" timestamp (3) with time zone,
	"last_error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_index_state_singleton_uq" UNIQUE("singleton"),
	CONSTRAINT "search_index_state_singleton_check" CHECK ("search_index_state"."singleton")
);
--> statement-breakpoint
CREATE TABLE "search_pins" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_pins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"query" text NOT NULL,
	"match" text NOT NULL,
	"pinned" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hidden" bigint[] DEFAULT '{}' NOT NULL,
	"starts_at" timestamp (3) with time zone,
	"ends_at" timestamp (3) with time zone,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_pins_query_match_uq" UNIQUE("query","match"),
	CONSTRAINT "search_pins_match_check" CHECK ("search_pins"."match" in ('exact', 'contains')),
	CONSTRAINT "search_pins_query_check" CHECK (char_length("search_pins"."query") between 1 and 100),
	CONSTRAINT "search_pins_lists_check" CHECK (jsonb_typeof("search_pins"."pinned") = 'array' and jsonb_array_length("search_pins"."pinned") <= 10 and cardinality("search_pins"."hidden") <= 50),
	CONSTRAINT "search_pins_window_check" CHECK ("search_pins"."starts_at" is null or "search_pins"."ends_at" is null or "search_pins"."ends_at" > "search_pins"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "search_synonyms" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_synonyms_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"root" text,
	"terms" text[] DEFAULT '{}' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_synonyms_kind_check" CHECK ("search_synonyms"."kind" in ('multi', 'one_way')),
	CONSTRAINT "search_synonyms_root_check" CHECK ("search_synonyms"."kind" <> 'one_way' or "search_synonyms"."root" is not null),
	CONSTRAINT "search_synonyms_terms_check" CHECK (cardinality("search_synonyms"."terms") between 2 and 20)
);
--> statement-breakpoint
CREATE TABLE "search_terms_daily" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "search_terms_daily_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"day" date NOT NULL,
	"term" text NOT NULL,
	"searches" integer DEFAULT 0 NOT NULL,
	"zero_results" integer DEFAULT 0 NOT NULL,
	"visitors" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_terms_daily_day_term_uq" UNIQUE("day","term"),
	CONSTRAINT "search_terms_daily_term_check" CHECK (char_length("search_terms_daily"."term") between 1 and 64),
	CONSTRAINT "search_terms_daily_counts_check" CHECK ("search_terms_daily"."searches" >= 0 and "search_terms_daily"."zero_results" >= 0 and "search_terms_daily"."zero_results" <= "search_terms_daily"."searches" and "search_terms_daily"."visitors" >= 0)
);
--> statement-breakpoint
ALTER TABLE "search_hidden_terms" ADD CONSTRAINT "search_hidden_terms_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_pins" ADD CONSTRAINT "search_pins_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_synonyms" ADD CONSTRAINT "search_synonyms_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "search_hidden_terms_created_by_idx" ON "search_hidden_terms" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "search_pins_created_by_idx" ON "search_pins" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "search_synonyms_created_by_idx" ON "search_synonyms" USING btree ("created_by");--> statement-breakpoint
INSERT INTO "search_synonyms" ("kind", "terms", "note") VALUES
  ('multi', ARRAY['frp', 'google account lock', 'frp lock'], 'Starting synonyms (feature 29)'),
  ('multi', ARRAY['icloud', 'activation lock', 'icloud lock'], 'Starting synonyms (feature 29)'),
  ('multi', ARRAY['unlock', 'network unlock', 'carrier unlock', 'sim unlock'], 'Starting synonyms (feature 29)'),
  ('multi', ARRAY['imei check', 'blacklist check', 'gsma check', 'clean check'], 'Starting synonyms (feature 29)'),
  ('multi', ARRAY['kg lock', 'knox guard', 'knox guard lock'], 'Starting synonyms (feature 29)');
