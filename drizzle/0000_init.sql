CREATE TABLE "alert_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alert_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"rule_id" bigint NOT NULL,
	"status" text DEFAULT 'firing' NOT NULL,
	"severity" text NOT NULL,
	"value" numeric(18, 4) NOT NULL,
	"subject_type" text,
	"subject_id" bigint,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"acknowledged_by" bigint,
	"acknowledged_at" timestamp (3) with time zone,
	"resolved_at" timestamp (3) with time zone,
	"note" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_events_status_check" CHECK ("alert_events"."status" in ('firing', 'acknowledged', 'resolved')),
	CONSTRAINT "alert_events_severity_check" CHECK ("alert_events"."severity" in ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "alert_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"name" text NOT NULL,
	"metric" text NOT NULL,
	"comparator" text NOT NULL,
	"threshold" numeric(18, 4) NOT NULL,
	"window_seconds" integer NOT NULL,
	"severity" text NOT NULL,
	"channels" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"muted_until" timestamp (3) with time zone,
	"created_by" bigint,
	"updated_by" bigint,
	"deleted_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "alert_rules_comparator_check" CHECK ("alert_rules"."comparator" in ('gt', 'gte', 'lt', 'lte')),
	CONSTRAINT "alert_rules_severity_check" CHECK ("alert_rules"."severity" in ('info', 'warning', 'critical')),
	CONSTRAINT "alert_rules_channels_check" CHECK ("alert_rules"."channels" <@ array['email', 'telegram']::text[]),
	CONSTRAINT "alert_rules_window_check" CHECK ("alert_rules"."window_seconds" > 0)
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" bigint NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"allowed_ips" "cidr"[] DEFAULT '{}' NOT NULL,
	"rate_limit_per_min" integer NOT NULL,
	"last_used_at" timestamp (3) with time zone,
	"last_used_ip" text,
	"expires_at" timestamp (3) with time zone,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_type" text NOT NULL,
	"actor_id" bigint,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" bigint NOT NULL,
	"entity_label" text DEFAULT '' NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"ip" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "auth_tokens_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"purpose" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"used_at" timestamp (3) with time zone,
	"ip" text,
	"created_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_subject_type_check" CHECK ("auth_tokens"."subject_type" in ('staff', 'client', 'customer'))
);
--> statement-breakpoint
CREATE TABLE "blocklist_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "blocklist_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"value_hash" text NOT NULL,
	"display" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocklist_entries_value_uq" UNIQUE("kind","value_hash"),
	CONSTRAINT "blocklist_entries_kind_check" CHECK ("blocklist_entries"."kind" in ('email', 'domain', 'imei', 'card', 'device', 'country')),
	CONSTRAINT "blocklist_entries_source_check" CHECK ("blocklist_entries"."source" in ('manual', 'auto', 'chargeback'))
);
--> statement-breakpoint
CREATE TABLE "checkout_sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkout_sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token" text NOT NULL,
	"customer_id" bigint,
	"email" text NOT NULL,
	"service_id" bigint NOT NULL,
	"imei_enc" text,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"currency" text NOT NULL,
	"fx_rate" numeric(18, 8) DEFAULT '1' NOT NULL,
	"net_amount" numeric(18, 4) NOT NULL,
	"tax_rate" numeric(9, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"gross_amount" numeric(18, 4) NOT NULL,
	"tax_country" text,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"order_id" bigint,
	"recovery_emailed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkout_sessions_quantity_check" CHECK ("checkout_sessions"."quantity" > 0 and "checkout_sessions"."gross_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "client_groups" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "client_groups_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"kind" text DEFAULT 'b2b' NOT NULL,
	"discount_percent" numeric(9, 4) DEFAULT '0' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"earn_threshold" numeric(18, 4) DEFAULT '0' NOT NULL,
	"deposit_limit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"overdraft_allowed" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "clients_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"name" text NOT NULL,
	"company" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"group_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"kyc_status" text DEFAULT 'none' NOT NULL,
	"referred_by_id" bigint,
	"referral_code" text NOT NULL,
	"totp_secret_enc" text,
	"email_verified_at" timestamp (3) with time zone,
	"telegram_chat_id" text,
	"notification_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"suspended_at" timestamp (3) with time zone,
	"suspended_reason" text,
	"suspended_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_status_check" CHECK ("clients"."status" in ('active', 'suspended', 'pending')),
	CONSTRAINT "clients_kyc_status_check" CHECK ("clients"."kyc_status" in ('none', 'pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "commission_accruals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commission_accruals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"plan_id" bigint NOT NULL,
	"beneficiary_id" bigint NOT NULL,
	"order_id" bigint,
	"period" text NOT NULL,
	"basis_amount" numeric(18, 4) NOT NULL,
	"percent" numeric(9, 4) NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"status" text NOT NULL,
	"ledger_tx_id" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_assignments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commission_assignments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"plan_id" bigint NOT NULL,
	"beneficiary_id" bigint NOT NULL,
	"scope" text NOT NULL,
	"starts_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_plans" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "commission_plans_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"basis" text NOT NULL,
	"percent" numeric(9, 4) DEFAULT '0' NOT NULL,
	"tiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"period" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "commission_plans_kind_check" CHECK ("commission_plans"."kind" in ('referral', 'rebate')),
	CONSTRAINT "commission_plans_percent_check" CHECK ("commission_plans"."percent" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "consent_records_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"subject_type" text NOT NULL,
	"subject_id" bigint NOT NULL,
	"legal_document_id" bigint,
	"purpose" text NOT NULL,
	"granted" boolean DEFAULT false NOT NULL,
	"checkout_session_id" bigint,
	"order_id" bigint,
	"ip" text,
	"user_agent" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_pages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "content_pages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"seo_title" text DEFAULT '' NOT NULL,
	"seo_description" text DEFAULT '' NOT NULL,
	"canonical_url" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp (3) with time zone,
	"author_id" bigint,
	"template_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_pages_slug_uq" UNIQUE("locale","slug"),
	CONSTRAINT "content_pages_kind_check" CHECK ("content_pages"."kind" in ('country', 'model', 'brand', 'carrier', 'tool', 'static', 'blog')),
	CONSTRAINT "content_pages_status_check" CHECK ("content_pages"."status" in ('draft', 'published', 'noindex'))
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "currencies_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate_to_base" numeric(18, 8) DEFAULT '1' NOT NULL,
	"rate_updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"markup_percent" numeric(9, 4) DEFAULT '0' NOT NULL,
	"charm_rounding" boolean DEFAULT false NOT NULL,
	"is_storefront" boolean DEFAULT false NOT NULL,
	"decimals" integer DEFAULT 2 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "currencies_code_uq" UNIQUE("code"),
	CONSTRAINT "currencies_rate_check" CHECK ("currencies"."rate_to_base" > 0),
	CONSTRAINT "currencies_decimals_check" CHECK ("currencies"."decimals" between 0 and 8)
);
--> statement-breakpoint
CREATE TABLE "customer_credentials" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customer_credentials_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" bigint NOT NULL,
	"password_hash" text,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"password_changed_at" timestamp (3) with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp (3) with time zone,
	"updated_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_credentials_customer_uq" UNIQUE("customer_id")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "customers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email" text NOT NULL,
	"email_verified_at" timestamp (3) with time zone,
	"name" text DEFAULT '' NOT NULL,
	"phone" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"currency" text,
	"has_account" boolean DEFAULT false NOT NULL,
	"created_by" bigint,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"risk_level" text DEFAULT 'low' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"suspended_at" timestamp (3) with time zone,
	"suspended_reason" text,
	"suspended_by" bigint,
	"internal_notes" text DEFAULT '' NOT NULL,
	"last_login_at" timestamp (3) with time zone,
	"first_order_at" timestamp (3) with time zone,
	"total_spent" numeric(18, 4) DEFAULT '0' NOT NULL,
	"anonymized_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_risk_level_check" CHECK ("customers"."risk_level" in ('low', 'medium', 'high')),
	CONSTRAINT "customers_status_check" CHECK ("customers"."status" in ('active', 'suspended', 'blocked', 'anonymized'))
);
--> statement-breakpoint
CREATE TABLE "data_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "data_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"requested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"due_at" timestamp (3) with time zone NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"handled_by" bigint,
	"file_id" bigint,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_requests_kind_check" CHECK ("data_requests"."kind" in ('export', 'erasure')),
	CONSTRAINT "data_requests_status_check" CHECK ("data_requests"."status" in ('open', 'in_progress', 'completed', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "disputes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"payment_id" bigint NOT NULL,
	"order_id" bigint,
	"customer_id" bigint,
	"gateway_dispute_id" text NOT NULL,
	"reason_code" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"currency" text NOT NULL,
	"fee" numeric(18, 4) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'needs_response' NOT NULL,
	"evidence_due_at" timestamp (3) with time zone NOT NULL,
	"evidence_file_ids" bigint[] DEFAULT '{}' NOT NULL,
	"submitted_at" timestamp (3) with time zone,
	"resolved_at" timestamp (3) with time zone,
	"ledger_tx_id" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_gateway_dispute_uq" UNIQUE("payment_id","gateway_dispute_id"),
	CONSTRAINT "disputes_status_check" CHECK ("disputes"."status" in ('needs_response', 'under_review', 'won', 'lost')),
	CONSTRAINT "disputes_amount_check" CHECK ("disputes"."amount" > 0 and "disputes"."fee" >= 0)
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "files_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"bucket" text NOT NULL,
	"key" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" bigint NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_object_uq" UNIQUE("bucket","key")
);
--> statement-breakpoint
CREATE TABLE "help_articles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "help_articles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category" text NOT NULL,
	"question" text NOT NULL,
	"answer_md" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"service_id" bigint,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_published" boolean DEFAULT false NOT NULL,
	"helpful_yes" integer DEFAULT 0 NOT NULL,
	"helpful_no" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imei_checks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "imei_checks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"imei_hash" text NOT NULL,
	"imei_enc" text NOT NULL,
	"tac" text,
	"brand" text DEFAULT '' NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"check_type" text NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"supplier_id" bigint,
	"service_id" bigint,
	"customer_id" bigint,
	"checkout_session_id" bigint,
	"source" text NOT NULL,
	"cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"price" numeric(18, 4) DEFAULT '0' NOT NULL,
	"ip" text,
	"cached_until" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imei_checks_check_type_check" CHECK ("imei_checks"."check_type" in ('blacklist', 'basic', 'icloud', 'sim_lock')),
	CONSTRAINT "imei_checks_status_check" CHECK ("imei_checks"."status" in ('clean', 'blacklisted', 'locked', 'unknown')),
	CONSTRAINT "imei_checks_source_check" CHECK ("imei_checks"."source" in ('pre_order', 'storefront_free'))
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "incidents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'investigating' NOT NULL,
	"components" text[] DEFAULT '{}' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"timeline" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"root_cause" text,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp (3) with time zone,
	"alert_event_id" bigint,
	"created_by" bigint,
	"resolved_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_severity_check" CHECK ("incidents"."severity" in ('minor', 'major', 'critical')),
	CONSTRAINT "incidents_status_check" CHECK ("incidents"."status" in ('investigating', 'identified', 'monitoring', 'resolved'))
);
--> statement-breakpoint
CREATE TABLE "inventory_codes" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "inventory_codes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" bigint NOT NULL,
	"code_enc" text NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"order_id" bigint,
	"batch_ref" text,
	"created_by" bigint,
	"code_hash" text NOT NULL,
	"code_last4" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_codes_status_check" CHECK ("inventory_codes"."status" in ('available', 'reserved', 'sold', 'void'))
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "invoices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"client_id" bigint,
	"customer_id" bigint,
	"order_id" bigint,
	"kind" text NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"fee" numeric(18, 4) DEFAULT '0' NOT NULL,
	"net_amount" numeric(18, 4),
	"tax_amount" numeric(18, 4),
	"tax_rate" numeric(9, 4),
	"tax_country" text,
	"customer_vat_id" text,
	"total" numeric(18, 4) NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"gateway_id" bigint,
	"pdf_file_id" bigint,
	"due_at" timestamp (3) with time zone,
	"paid_at" timestamp (3) with time zone,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_kind_check" CHECK ("invoices"."kind" in ('topup', 'manual', 'receipt', 'statement')),
	CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" in ('open', 'paid', 'void')),
	CONSTRAINT "invoices_amount_check" CHECK ("invoices"."amount" >= 0 and "invoices"."fee" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ip_rules" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ip_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"cidr" "cidr" NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp (3) with time zone,
	"created_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ip_rules_kind_check" CHECK ("ip_rules"."kind" in ('allow', 'block')),
	CONSTRAINT "ip_rules_scope_check" CHECK ("ip_rules"."scope" in ('store', 'api', 'admin', 'all')),
	CONSTRAINT "ip_rules_source_check" CHECK ("ip_rules"."source" in ('manual', 'auto'))
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_runs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"job" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp (3) with time zone,
	"duration_ms" integer,
	"processed" integer,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"triggered_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_runs_trigger_check" CHECK ("job_runs"."trigger" in ('manual', 'event', 'schedule')),
	CONSTRAINT "job_runs_status_check" CHECK ("job_runs"."status" in ('running', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "kyc_submissions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "kyc_submissions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"file_ids" bigint[] DEFAULT '{}' NOT NULL,
	"reviewed_by" bigint,
	"reviewed_at" timestamp (3) with time zone,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kyc_submissions_status_check" CHECK ("kyc_submissions"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_accounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"owner_type" text,
	"owner_id" bigint,
	"currency" text NOT NULL,
	"balance" numeric(18, 4) DEFAULT '0' NOT NULL,
	"overdraft_limit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_identity_uq" UNIQUE NULLS NOT DISTINCT("kind","owner_type","owner_id","currency"),
	CONSTRAINT "ledger_accounts_kind_check" CHECK ("ledger_accounts"."kind" in ('fee_income', 'vat_payable', 'chargeback_loss', 'bank', 'gateway_fees', 'gateway_clearing', 'customer_funds', 'revenue', 'cogs', 'adjustments', 'commission_expense', 'owner_capital', 'client_wallet', 'client_hold', 'supplier_prepaid')),
	CONSTRAINT "ledger_accounts_owner_type_check" CHECK ("ledger_accounts"."owner_type" in ('client', 'supplier', 'customer')),
	CONSTRAINT "ledger_accounts_owner_check" CHECK (("ledger_accounts"."owner_type" is null) = ("ledger_accounts"."owner_id" is null)),
	CONSTRAINT "ledger_accounts_kind_owner_check" CHECK (("ledger_accounts"."kind" in ('client_wallet', 'client_hold') and "ledger_accounts"."owner_type" is not distinct from 'client')
 or ("ledger_accounts"."kind" = 'supplier_prepaid' and "ledger_accounts"."owner_type" is not distinct from 'supplier')
 or ("ledger_accounts"."kind" not in ('client_wallet', 'client_hold', 'supplier_prepaid') and "ledger_accounts"."owner_type" is null)),
	CONSTRAINT "ledger_accounts_overdraft_check" CHECK ("ledger_accounts"."overdraft_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"transaction_id" bigint NOT NULL,
	"account_id" bigint NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"balance_after" numeric(18, 4) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_amount_check" CHECK ("ledger_entries"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_transactions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" bigint,
	"memo" text DEFAULT '' NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_by_type" text NOT NULL,
	"created_by_id" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_transactions_ref_type_check" CHECK ("ledger_transactions"."ref_type" in ('order', 'payment', 'invoice', 'refund', 'dispute', 'accrual', 'supplier', 'client', 'system', 'ledger_transaction')),
	CONSTRAINT "ledger_transactions_created_by_type_check" CHECK ("ledger_transactions"."created_by_type" in ('staff', 'client', 'customer', 'system')),
	CONSTRAINT "ledger_transactions_actor_check" CHECK (("ledger_transactions"."created_by_type" = 'system') = ("ledger_transactions"."created_by_id" is null))
);
--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "legal_documents_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"version" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"body_md" text NOT NULL,
	"effective_from" timestamp (3) with time zone,
	"is_current" boolean DEFAULT false NOT NULL,
	"requires_reacceptance" boolean DEFAULT false NOT NULL,
	"created_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legal_documents_version_uq" UNIQUE("type","locale","version")
);
--> statement-breakpoint
CREATE TABLE "notification_templates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notification_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"event" text NOT NULL,
	"channel" text NOT NULL,
	"audience" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_templates_event_uq" UNIQUE("event","channel","audience","locale"),
	CONSTRAINT "notification_templates_channel_check" CHECK ("notification_templates"."channel" in ('email', 'telegram')),
	CONSTRAINT "notification_templates_audience_check" CHECK ("notification_templates"."audience" in ('staff', 'customer', 'merchant'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"recipient_type" text NOT NULL,
	"recipient_id" bigint NOT NULL,
	"channel" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"sent_at" timestamp (3) with time zone,
	"error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_channel_check" CHECK ("notifications"."channel" in ('email', 'telegram')),
	CONSTRAINT "notifications_status_check" CHECK ("notifications"."status" in ('queued', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"order_id" bigint NOT NULL,
	"type" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"actor_type" text NOT NULL,
	"actor_id" bigint,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_events_from_status_check" CHECK ("order_events"."from_status" in ('pending', 'processing', 'completed', 'rejected')),
	CONSTRAINT "order_events_to_status_check" CHECK ("order_events"."to_status" in ('pending', 'processing', 'completed', 'rejected')),
	CONSTRAINT "order_events_actor_type_check" CHECK ("order_events"."actor_type" in ('staff', 'client', 'customer', 'supplier', 'system')),
	CONSTRAINT "order_events_actor_check" CHECK (("order_events"."actor_type" = 'system') = ("order_events"."actor_id" is null))
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "orders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" bigint,
	"customer_id" bigint,
	"service_id" bigint NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"api_key_id" bigint,
	"status" text DEFAULT 'pending' NOT NULL,
	"dispatch_state" text DEFAULT 'pending' NOT NULL,
	"imei" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unit_price" numeric(18, 4) NOT NULL,
	"total_price" numeric(18, 4) NOT NULL,
	"unit_cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"total_cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"pricing_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"public_token" text,
	"checkout_session_id" bigint,
	"tax_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"tax_country" text,
	"supplier_id" bigint,
	"supplier_service_id" bigint,
	"supplier_ref" text,
	"result_code" text,
	"result_comment" text,
	"client_note" text,
	"admin_note" text,
	"verification_status" text,
	"idempotency_key" text,
	"fingerprint" text,
	"input_file_id" bigint,
	"result_file_id" bigint,
	"placed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_type_check" CHECK ("orders"."type" in ('imei', 'server', 'remote', 'file')),
	CONSTRAINT "orders_source_check" CHECK ("orders"."source" in ('dhru', 'v1', 'portal', 'store', 'admin')),
	CONSTRAINT "orders_status_check" CHECK ("orders"."status" in ('pending', 'processing', 'completed', 'rejected')),
	CONSTRAINT "orders_dispatch_state_check" CHECK ("orders"."dispatch_state" in ('pending', 'held', 'manual', 'operator', 'sent', 'needs_attention', 'done')),
	CONSTRAINT "orders_buyer_check" CHECK (("orders"."client_id" is null) <> ("orders"."customer_id" is null)),
	CONSTRAINT "orders_quantity_check" CHECK ("orders"."quantity" > 0),
	CONSTRAINT "orders_amounts_check" CHECK ("orders"."unit_price" >= 0 and "orders"."total_price" >= 0 and "orders"."unit_cost" >= 0 and "orders"."total_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outbox_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" bigint NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed_at" timestamp (3) with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_gateways" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payment_gateways_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"code" text NOT NULL,
	"driver" text NOT NULL,
	"name" text NOT NULL,
	"audience" text DEFAULT 'both' NOT NULL,
	"config_enc" text,
	"webhook_secret_enc" text,
	"fee_percent" numeric(9, 4) DEFAULT '0' NOT NULL,
	"fee_fixed" numeric(18, 4) DEFAULT '0' NOT NULL,
	"min_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"max_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"allowed_group_ids" bigint[] DEFAULT '{}' NOT NULL,
	"supports_refunds" boolean DEFAULT false NOT NULL,
	"supports_3ds" boolean DEFAULT false NOT NULL,
	"is_manual" boolean DEFAULT false NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"hold_hours" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_gateways_audience_check" CHECK ("payment_gateways"."audience" in ('b2b', 'b2c', 'both')),
	CONSTRAINT "payment_gateways_fee_check" CHECK ("payment_gateways"."fee_percent" between 0 and 100 and "payment_gateways"."fee_fixed" >= 0),
	CONSTRAINT "payment_gateways_limits_check" CHECK ("payment_gateways"."min_amount" >= 0 and "payment_gateways"."max_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"invoice_id" bigint,
	"customer_id" bigint,
	"order_id" bigint,
	"purpose" text NOT NULL,
	"gateway_id" bigint NOT NULL,
	"gateway_txn_id" text,
	"amount" numeric(18, 4) NOT NULL,
	"fee_amount" numeric(18, 4) DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"method_type" text NOT NULL,
	"three_ds" boolean DEFAULT false NOT NULL,
	"captured_at" timestamp (3) with time zone,
	"receipt_file_id" bigint,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reviewed_by" bigint,
	"reviewed_at" timestamp (3) with time zone,
	"review_note" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_purpose_check" CHECK ("payments"."purpose" in ('topup', 'order')),
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount" > 0 and "payments"."fee_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pricing_rules" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "pricing_rules_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"scope" text NOT NULL,
	"target_id" bigint,
	"group_id" bigint,
	"kind" text NOT NULL,
	"percent" numeric(9, 4) DEFAULT '0' NOT NULL,
	"fixed" numeric(18, 4) DEFAULT '0' NOT NULL,
	"rounding" text DEFAULT 'none' NOT NULL,
	"min_profit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp (3) with time zone,
	"ends_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pricing_rules_scope_check" CHECK ("pricing_rules"."scope" in ('global', 'category', 'service')),
	CONSTRAINT "pricing_rules_kind_check" CHECK ("pricing_rules"."kind" in ('margin', 'discount', 'promo')),
	CONSTRAINT "pricing_rules_rounding_check" CHECK ("pricing_rules"."rounding" in ('none', 'nearest_0.05', 'nearest_0.10', 'ends_99')),
	CONSTRAINT "pricing_rules_target_check" CHECK (("pricing_rules"."scope" = 'global') = ("pricing_rules"."target_id" is null)),
	CONSTRAINT "pricing_rules_window_check" CHECK ("pricing_rules"."ends_at" is null or "pricing_rules"."starts_at" is null or "pricing_rules"."ends_at" > "pricing_rules"."starts_at")
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "refunds_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"payment_id" bigint,
	"order_id" bigint,
	"customer_id" bigint,
	"client_id" bigint,
	"amount" numeric(18, 4) NOT NULL,
	"currency" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"gateway_refund_id" text,
	"requested_by_type" text NOT NULL,
	"requested_by_id" bigint,
	"approved_by" bigint,
	"ledger_tx_id" bigint,
	"completed_at" timestamp (3) with time zone,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_status_check" CHECK ("refunds"."status" in ('requested', 'processing', 'completed', 'failed', 'rejected')),
	CONSTRAINT "refunds_requested_by_type_check" CHECK ("refunds"."requested_by_type" in ('staff', 'customer', 'system')),
	CONSTRAINT "refunds_amount_check" CHECK ("refunds"."amount" > 0),
	CONSTRAINT "refunds_requester_check" CHECK (("refunds"."requested_by_type" = 'system') = ("refunds"."requested_by_id" is null))
);
--> statement-breakpoint
CREATE TABLE "reply_templates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reply_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"title" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"body" text NOT NULL,
	"shortcut" text,
	"created_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reply_templates_category_check" CHECK ("reply_templates"."category" in ('refund', 'delay', 'failed_unlock', 'billing', 'wrong_imei', 'howto', 'presale', 'other'))
);
--> statement-breakpoint
CREATE TABLE "risk_assessments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "risk_assessments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"checkout_session_id" bigint,
	"order_id" bigint,
	"customer_id" bigint,
	"score" integer NOT NULL,
	"decision" text NOT NULL,
	"signals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text DEFAULT 'internal' NOT NULL,
	"reviewed_by" bigint,
	"reviewed_at" timestamp (3) with time zone,
	"outcome" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "risk_assessments_decision_check" CHECK ("risk_assessments"."decision" in ('allow', 'review', 'block')),
	CONSTRAINT "risk_assessments_outcome_check" CHECK ("risk_assessments"."outcome" in ('approved', 'refunded'))
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "roles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_categories" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_categories_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"type" text NOT NULL,
	"allowed_group_ids" bigint[] DEFAULT '{}' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_categories_type_check" CHECK ("service_categories"."type" in ('imei', 'server', 'remote', 'file'))
);
--> statement-breakpoint
CREATE TABLE "service_checks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_checks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"component" text NOT NULL,
	"supplier_id" bigint,
	"gateway_id" bigint,
	"status" text NOT NULL,
	"latency_ms" integer,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checked_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_checks_status_check" CHECK ("service_checks"."status" in ('ok', 'degraded', 'down', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "service_client_prices" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_client_prices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" bigint NOT NULL,
	"client_id" bigint NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_by" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_client_prices_uq" UNIQUE("service_id","client_id"),
	CONSTRAINT "service_client_prices_price_check" CHECK ("service_client_prices"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "service_fields" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_fields_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" bigint NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text DEFAULT 'text' NOT NULL,
	"options" text[] DEFAULT '{}' NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"regex" text DEFAULT '' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"supplier_key" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_fields_key_uq" UNIQUE("service_id","key"),
	CONSTRAINT "service_fields_field_type_check" CHECK ("service_fields"."field_type" in ('text', 'number', 'select', 'textarea'))
);
--> statement-breakpoint
CREATE TABLE "service_group_prices" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_group_prices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" bigint NOT NULL,
	"group_id" bigint NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_group_prices_uq" UNIQUE("service_id","group_id"),
	CONSTRAINT "service_group_prices_price_check" CHECK ("service_group_prices"."price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "service_listings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_listings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" bigint NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"slug" text NOT NULL,
	"public_title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"description_md" text DEFAULT '' NOT NULL,
	"eta_text" text DEFAULT '' NOT NULL,
	"requirements_md" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT '' NOT NULL,
	"carrier" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"is_listed" boolean DEFAULT false NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"seo_title" text DEFAULT '' NOT NULL,
	"seo_description" text DEFAULT '' NOT NULL,
	"og_file_id" bigint,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_listings_service_locale_uq" UNIQUE("service_id","locale"),
	CONSTRAINT "service_listings_slug_uq" UNIQUE("locale","slug")
);
--> statement-breakpoint
CREATE TABLE "service_options" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_options_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" bigint NOT NULL,
	"list" text NOT NULL,
	"value" text NOT NULL,
	"label" text NOT NULL,
	"supplier_value" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_options_value_uq" UNIQUE("service_id","list","value"),
	CONSTRAINT "service_options_list_check" CHECK ("service_options"."list" in ('model', 'network', 'mep'))
);
--> statement-breakpoint
CREATE TABLE "service_supplier_links" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "service_supplier_links_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"service_id" bigint NOT NULL,
	"supplier_service_id" bigint NOT NULL,
	"priority" integer DEFAULT 1 NOT NULL,
	"field_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_supplier_links_uq" UNIQUE("service_id","supplier_service_id")
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "services_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"category_id" bigint NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"info" text DEFAULT '' NOT NULL,
	"delivery_time" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"fulfillment" text NOT NULL,
	"price_mode" text NOT NULL,
	"base_price" numeric(18, 4),
	"cost" numeric(18, 4) DEFAULT '0' NOT NULL,
	"cost_currency" text DEFAULT 'USD' NOT NULL,
	"min_qty" integer DEFAULT 1 NOT NULL,
	"max_qty" integer DEFAULT 1 NOT NULL,
	"qty_options" integer[] DEFAULT '{}' NOT NULL,
	"allow_free" boolean DEFAULT false NOT NULL,
	"duplicate_rule" text NOT NULL,
	"allow_cancel" boolean DEFAULT false NOT NULL,
	"allow_verify" boolean DEFAULT false NOT NULL,
	"verify_window_h" integer DEFAULT 0 NOT NULL,
	"requires" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"code" text NOT NULL,
	"sla_minutes" integer NOT NULL,
	"min_profit" numeric(18, 4),
	"cost_was" numeric(18, 4),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_type_check" CHECK ("services"."type" in ('imei', 'server', 'remote', 'file')),
	CONSTRAINT "services_status_check" CHECK ("services"."status" in ('active', 'disabled')),
	CONSTRAINT "services_fulfillment_check" CHECK ("services"."fulfillment" in ('auto', 'manual')),
	CONSTRAINT "services_qty_check" CHECK ("services"."min_qty" >= 1 and "services"."max_qty" >= "services"."min_qty"),
	CONSTRAINT "services_prices_check" CHECK ("services"."cost" >= 0 and ("services"."base_price" is null or "services"."base_price" >= 0)),
	CONSTRAINT "services_sla_check" CHECK ("services"."sla_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sessions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"token_hash" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" bigint NOT NULL,
	"stage" text NOT NULL,
	"ip" text NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_subject_type_check" CHECK ("sessions"."subject_type" in ('staff', 'client', 'customer')),
	CONSTRAINT "sessions_stage_check" CHECK ("sessions"."stage" in ('pending_password', 'pending_totp_setup', 'pending_totp', 'active'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "settings_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_key_uq" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "staff_users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "staff_users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email" text NOT NULL,
	"password_hash" text,
	"name" text NOT NULL,
	"role_id" bigint NOT NULL,
	"totp_secret_enc" text,
	"twofa_enabled" boolean DEFAULT false NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"password_changed_at" timestamp (3) with time zone,
	"status" text DEFAULT 'invited' NOT NULL,
	"suspended_at" timestamp (3) with time zone,
	"suspended_reason" text,
	"suspended_by" bigint,
	"created_by" bigint,
	"last_login_at" timestamp (3) with time zone,
	"last_login_ip" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_users_status_check" CHECK ("staff_users"."status" in ('invited', 'active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "supplier_api_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_api_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"supplier_id" bigint NOT NULL,
	"order_id" bigint,
	"action" text NOT NULL,
	"request" jsonb,
	"response" jsonb,
	"http_status" integer,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_services" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "supplier_services_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"supplier_id" bigint NOT NULL,
	"remote_id" text NOT NULL,
	"remote_group" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"credit" numeric(18, 4) DEFAULT '0' NOT NULL,
	"time" text DEFAULT '' NOT NULL,
	"requires" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"custom_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_available" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"price_changed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_services_remote_uq" UNIQUE("supplier_id","remote_id")
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "suppliers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"driver" text NOT NULL,
	"base_url" text NOT NULL,
	"username" text DEFAULT '' NOT NULL,
	"api_key_enc" text,
	"param_format" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"credit_rate" numeric(18, 8) DEFAULT '1' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"balance" numeric(18, 4) DEFAULT '0' NOT NULL,
	"balance_checked_at" timestamp (3) with time zone,
	"low_balance_alert" numeric(18, 4) DEFAULT '0' NOT NULL,
	"max_concurrency" integer NOT NULL,
	"rate_limit_per_min" integer NOT NULL,
	"timeout_ms" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "suppliers_status_check" CHECK ("suppliers"."status" in ('active', 'disabled', 'paused'))
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "support_tickets_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"number" text NOT NULL,
	"subject" text NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"requester_type" text NOT NULL,
	"requester_id" bigint NOT NULL,
	"order_id" bigint,
	"category" text DEFAULT 'other' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"assignee_id" bigint,
	"sla_due_at" timestamp (3) with time zone,
	"first_response_at" timestamp (3) with time zone,
	"resolved_at" timestamp (3) with time zone,
	"csat_score" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_tickets_channel_check" CHECK ("support_tickets"."channel" in ('email', 'telegram', 'web', 'chat')),
	CONSTRAINT "support_tickets_requester_type_check" CHECK ("support_tickets"."requester_type" in ('client', 'customer')),
	CONSTRAINT "support_tickets_category_check" CHECK ("support_tickets"."category" in ('refund', 'delay', 'failed_unlock', 'billing', 'wrong_imei', 'howto', 'presale', 'other')),
	CONSTRAINT "support_tickets_priority_check" CHECK ("support_tickets"."priority" in ('low', 'normal', 'high')),
	CONSTRAINT "support_tickets_status_check" CHECK ("support_tickets"."status" in ('new', 'open', 'pending_customer', 'resolved', 'closed')),
	CONSTRAINT "support_tickets_csat_check" CHECK ("support_tickets"."csat_score" is null or "support_tickets"."csat_score" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "tac_catalog" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tac_catalog_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tac" text NOT NULL,
	"brand" text NOT NULL,
	"model" text NOT NULL,
	"marketing_name" text DEFAULT '' NOT NULL,
	"release_year" integer,
	"source" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tac_catalog_tac_uq" UNIQUE("tac"),
	CONSTRAINT "tac_catalog_tac_check" CHECK ("tac_catalog"."tac" ~ '^[0-9]{8}$')
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "tax_rates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"country" text NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"rate_percent" numeric(9, 4) NOT NULL,
	"tax_type" text NOT NULL,
	"applies_to" text NOT NULL,
	"valid_from" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"valid_to" timestamp (3) with time zone,
	"label" text DEFAULT '' NOT NULL,
	"oss_scheme" text DEFAULT '' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_rate_check" CHECK ("tax_rates"."rate_percent" between 0 and 100),
	CONSTRAINT "tax_rates_validity_check" CHECK ("tax_rates"."valid_to" is null or "tax_rates"."valid_to" > "tax_rates"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ticket_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"ticket_id" bigint NOT NULL,
	"author_type" text NOT NULL,
	"author_id" bigint,
	"body" text NOT NULL,
	"is_internal" boolean DEFAULT false NOT NULL,
	"file_ids" bigint[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_messages_author_type_check" CHECK ("ticket_messages"."author_type" in ('staff', 'client', 'customer', 'system')),
	CONSTRAINT "ticket_messages_author_check" CHECK (("ticket_messages"."author_type" = 'system') = ("ticket_messages"."author_id" is null))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webhook_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"endpoint_id" bigint NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response_code" integer,
	"next_retry_at" timestamp (3) with time zone,
	"response_body" text,
	"error" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" in ('pending', 'delivered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "webhook_endpoints_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" bigint NOT NULL,
	"url" text NOT NULL,
	"secret_enc" text NOT NULL,
	"events" text[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawal_requests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "withdrawal_requests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" bigint NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"method" text NOT NULL,
	"destination" text NOT NULL,
	"status" text NOT NULL,
	"decided_by" bigint,
	"decided_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "withdrawal_requests_amount_check" CHECK ("withdrawal_requests"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_alert_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_acknowledged_by_staff_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocklist_entries" ADD CONSTRAINT "blocklist_entries_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkout_sessions" ADD CONSTRAINT "checkout_sessions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_group_id_client_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."client_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_referred_by_id_clients_id_fk" FOREIGN KEY ("referred_by_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_suspended_by_staff_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_plan_id_commission_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."commission_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_beneficiary_id_clients_id_fk" FOREIGN KEY ("beneficiary_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_accruals" ADD CONSTRAINT "commission_accruals_ledger_tx_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_tx_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_assignments" ADD CONSTRAINT "commission_assignments_plan_id_commission_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."commission_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_assignments" ADD CONSTRAINT "commission_assignments_beneficiary_id_clients_id_fk" FOREIGN KEY ("beneficiary_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_legal_document_id_legal_documents_id_fk" FOREIGN KEY ("legal_document_id") REFERENCES "public"."legal_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_author_id_staff_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credentials" ADD CONSTRAINT "customer_credentials_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credentials" ADD CONSTRAINT "customer_credentials_updated_by_staff_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_suspended_by_staff_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_handled_by_staff_users_id_fk" FOREIGN KEY ("handled_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_requests" ADD CONSTRAINT "data_requests_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_ledger_tx_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_tx_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "help_articles" ADD CONSTRAINT "help_articles_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imei_checks" ADD CONSTRAINT "imei_checks_tac_tac_catalog_tac_fk" FOREIGN KEY ("tac") REFERENCES "public"."tac_catalog"("tac") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imei_checks" ADD CONSTRAINT "imei_checks_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imei_checks" ADD CONSTRAINT "imei_checks_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imei_checks" ADD CONSTRAINT "imei_checks_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imei_checks" ADD CONSTRAINT "imei_checks_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_alert_event_id_alert_events_id_fk" FOREIGN KEY ("alert_event_id") REFERENCES "public"."alert_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_resolved_by_staff_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_codes" ADD CONSTRAINT "inventory_codes_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_codes" ADD CONSTRAINT "inventory_codes_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_codes" ADD CONSTRAINT "inventory_codes_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_gateway_id_payment_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."payment_gateways"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_pdf_file_id_files_id_fk" FOREIGN KEY ("pdf_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_rules" ADD CONSTRAINT "ip_rules_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_triggered_by_staff_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kyc_submissions" ADD CONSTRAINT "kyc_submissions_reviewed_by_staff_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_supplier_service_id_supplier_services_id_fk" FOREIGN KEY ("supplier_service_id") REFERENCES "public"."supplier_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_input_file_id_files_id_fk" FOREIGN KEY ("input_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_result_file_id_files_id_fk" FOREIGN KEY ("result_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_id_payment_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."payment_gateways"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_receipt_file_id_files_id_fk" FOREIGN KEY ("receipt_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_reviewed_by_staff_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_group_id_client_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."client_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_currency_currencies_code_fk" FOREIGN KEY ("currency") REFERENCES "public"."currencies"("code") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_approved_by_staff_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_ledger_tx_id_ledger_transactions_id_fk" FOREIGN KEY ("ledger_tx_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_templates" ADD CONSTRAINT "reply_templates_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_checkout_session_id_checkout_sessions_id_fk" FOREIGN KEY ("checkout_session_id") REFERENCES "public"."checkout_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_assessments" ADD CONSTRAINT "risk_assessments_reviewed_by_staff_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checks" ADD CONSTRAINT "service_checks_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_checks" ADD CONSTRAINT "service_checks_gateway_id_payment_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."payment_gateways"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_client_prices" ADD CONSTRAINT "service_client_prices_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_client_prices" ADD CONSTRAINT "service_client_prices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_client_prices" ADD CONSTRAINT "service_client_prices_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_fields" ADD CONSTRAINT "service_fields_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_group_prices" ADD CONSTRAINT "service_group_prices_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_group_prices" ADD CONSTRAINT "service_group_prices_group_id_client_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."client_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_listings" ADD CONSTRAINT "service_listings_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_listings" ADD CONSTRAINT "service_listings_og_file_id_files_id_fk" FOREIGN KEY ("og_file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_options" ADD CONSTRAINT "service_options_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_supplier_links" ADD CONSTRAINT "service_supplier_links_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_supplier_links" ADD CONSTRAINT "service_supplier_links_supplier_service_fk" FOREIGN KEY ("supplier_service_id") REFERENCES "public"."supplier_services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_service_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."service_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_suspended_by_staff_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_users" ADD CONSTRAINT "staff_users_created_by_staff_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_api_logs" ADD CONSTRAINT "supplier_api_logs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_api_logs" ADD CONSTRAINT "supplier_api_logs_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_services" ADD CONSTRAINT "supplier_services_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_staff_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_decided_by_staff_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_events_status_started_idx" ON "alert_events" USING btree ("status","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "alert_events_rule_id_idx" ON "alert_events" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "alert_events_acknowledged_by_idx" ON "alert_events" USING btree ("acknowledged_by");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_rules_key_uq" ON "alert_rules" USING btree ("key") WHERE "alert_rules"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "alert_rules_created_by_idx" ON "alert_rules" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "alert_rules_updated_by_idx" ON "alert_rules" USING btree ("updated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_uq" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_client_id_idx" ON "api_keys" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_type","actor_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_tokens_token_hash_uq" ON "auth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "auth_tokens_subject_idx" ON "auth_tokens" USING btree ("subject_type","subject_id","purpose","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "auth_tokens_created_by_idx" ON "auth_tokens" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "blocklist_entries_created_idx" ON "blocklist_entries" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "blocklist_entries_created_by_idx" ON "blocklist_entries" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "checkout_sessions_token_uq" ON "checkout_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "checkout_sessions_status_created_idx" ON "checkout_sessions" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checkout_sessions_created_idx" ON "checkout_sessions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checkout_sessions_customer_id_idx" ON "checkout_sessions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "checkout_sessions_service_id_idx" ON "checkout_sessions" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "checkout_sessions_currency_idx" ON "checkout_sessions" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "checkout_sessions_order_id_idx" ON "checkout_sessions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_groups_name_uq" ON "client_groups" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "client_groups_single_default_uq" ON "client_groups" USING btree ("is_default") WHERE "client_groups"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "client_groups_single_retail_uq" ON "client_groups" USING btree ("kind") WHERE "client_groups"."kind" = 'b2c_retail';--> statement-breakpoint
CREATE UNIQUE INDEX "clients_username_uq" ON "clients" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "clients_email_uq" ON "clients" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "clients_referral_code_uq" ON "clients" USING btree ("referral_code");--> statement-breakpoint
CREATE INDEX "clients_group_id_idx" ON "clients" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "clients_status_idx" ON "clients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clients_name_idx" ON "clients" USING btree ("name");--> statement-breakpoint
CREATE INDEX "clients_referred_by_id_idx" ON "clients" USING btree ("referred_by_id");--> statement-breakpoint
CREATE INDEX "clients_suspended_by_idx" ON "clients" USING btree ("suspended_by");--> statement-breakpoint
CREATE INDEX "commission_accruals_beneficiary_status_idx" ON "commission_accruals" USING btree ("beneficiary_id","status");--> statement-breakpoint
CREATE INDEX "commission_accruals_status_created_idx" ON "commission_accruals" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "commission_accruals_created_idx" ON "commission_accruals" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "commission_accruals_plan_id_idx" ON "commission_accruals" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "commission_accruals_order_id_idx" ON "commission_accruals" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "commission_accruals_ledger_tx_id_idx" ON "commission_accruals" USING btree ("ledger_tx_id");--> statement-breakpoint
CREATE UNIQUE INDEX "commission_assignments_active_uq" ON "commission_assignments" USING btree ("plan_id","beneficiary_id") WHERE "commission_assignments"."ends_at" is null;--> statement-breakpoint
CREATE INDEX "commission_assignments_beneficiary_id_idx" ON "commission_assignments" USING btree ("beneficiary_id");--> statement-breakpoint
CREATE INDEX "commission_assignments_plan_id_idx" ON "commission_assignments" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "consent_records_subject_idx" ON "consent_records" USING btree ("subject_type","subject_id","purpose","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "consent_records_legal_document_id_idx" ON "consent_records" USING btree ("legal_document_id");--> statement-breakpoint
CREATE INDEX "consent_records_checkout_session_id_idx" ON "consent_records" USING btree ("checkout_session_id");--> statement-breakpoint
CREATE INDEX "consent_records_order_id_idx" ON "consent_records" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "content_pages_kind_status_idx" ON "content_pages" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "content_pages_updated_idx" ON "content_pages" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "content_pages_author_id_idx" ON "content_pages" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "customer_credentials_updated_by_idx" ON "customer_credentials" USING btree ("updated_by");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_email_uq" ON "customers" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "customers_status_idx" ON "customers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "customers_total_spent_idx" ON "customers" USING btree ("total_spent" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "customers_risk_level_idx" ON "customers" USING btree ("risk_level");--> statement-breakpoint
CREATE INDEX "customers_country_idx" ON "customers" USING btree ("country");--> statement-breakpoint
CREATE INDEX "customers_currency_idx" ON "customers" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "customers_created_by_idx" ON "customers" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "customers_suspended_by_idx" ON "customers" USING btree ("suspended_by");--> statement-breakpoint
CREATE INDEX "data_requests_status_due_idx" ON "data_requests" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "data_requests_customer_id_idx" ON "data_requests" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "data_requests_handled_by_idx" ON "data_requests" USING btree ("handled_by");--> statement-breakpoint
CREATE INDEX "data_requests_file_id_idx" ON "data_requests" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "disputes_status_due_idx" ON "disputes" USING btree ("status","evidence_due_at");--> statement-breakpoint
CREATE INDEX "disputes_evidence_due_idx" ON "disputes" USING btree ("evidence_due_at");--> statement-breakpoint
CREATE INDEX "disputes_order_id_idx" ON "disputes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "disputes_customer_id_idx" ON "disputes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "disputes_currency_idx" ON "disputes" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "disputes_ledger_tx_id_idx" ON "disputes" USING btree ("ledger_tx_id");--> statement-breakpoint
CREATE INDEX "files_owner_idx" ON "files" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "files_sha256_idx" ON "files" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "help_articles_published_idx" ON "help_articles" USING btree ("is_published","sort");--> statement-breakpoint
CREATE INDEX "help_articles_service_id_idx" ON "help_articles" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "imei_checks_imei_hash_idx" ON "imei_checks" USING btree ("imei_hash","check_type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "imei_checks_source_created_idx" ON "imei_checks" USING btree ("source","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "imei_checks_created_idx" ON "imei_checks" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "imei_checks_tac_idx" ON "imei_checks" USING btree ("tac");--> statement-breakpoint
CREATE INDEX "imei_checks_supplier_id_idx" ON "imei_checks" USING btree ("supplier_id");--> statement-breakpoint
CREATE INDEX "imei_checks_service_id_idx" ON "imei_checks" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "imei_checks_customer_id_idx" ON "imei_checks" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "imei_checks_checkout_session_id_idx" ON "imei_checks" USING btree ("checkout_session_id");--> statement-breakpoint
CREATE INDEX "incidents_status_started_idx" ON "incidents" USING btree ("status","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_alert_event_id_idx" ON "incidents" USING btree ("alert_event_id");--> statement-breakpoint
CREATE INDEX "incidents_created_by_idx" ON "incidents" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "incidents_resolved_by_idx" ON "incidents" USING btree ("resolved_by");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_codes_code_hash_uq" ON "inventory_codes" USING btree ("code_hash") WHERE "inventory_codes"."status" <> 'void';--> statement-breakpoint
CREATE INDEX "inventory_codes_available_idx" ON "inventory_codes" USING btree ("service_id","id") WHERE "inventory_codes"."status" = 'available';--> statement-breakpoint
CREATE INDEX "inventory_codes_service_status_idx" ON "inventory_codes" USING btree ("service_id","status");--> statement-breakpoint
CREATE INDEX "inventory_codes_created_idx" ON "inventory_codes" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inventory_codes_order_id_idx" ON "inventory_codes" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "inventory_codes_created_by_idx" ON "inventory_codes" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("number");--> statement-breakpoint
CREATE INDEX "invoices_client_created_idx" ON "invoices" USING btree ("client_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invoices_status_created_idx" ON "invoices" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invoices_created_idx" ON "invoices" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "invoices_customer_id_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "invoices_order_id_idx" ON "invoices" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "invoices_currency_idx" ON "invoices" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "invoices_gateway_id_idx" ON "invoices" USING btree ("gateway_id");--> statement-breakpoint
CREATE INDEX "invoices_pdf_file_id_idx" ON "invoices" USING btree ("pdf_file_id");--> statement-breakpoint
CREATE INDEX "ip_rules_kind_created_idx" ON "ip_rules" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ip_rules_created_by_idx" ON "ip_rules" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "job_runs_job_started_idx" ON "job_runs" USING btree ("job","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "job_runs_running_idx" ON "job_runs" USING btree ("job") WHERE "job_runs"."status" = 'running';--> statement-breakpoint
CREATE INDEX "job_runs_triggered_by_idx" ON "job_runs" USING btree ("triggered_by");--> statement-breakpoint
CREATE INDEX "kyc_submissions_status_created_idx" ON "kyc_submissions" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kyc_submissions_client_id_idx" ON "kyc_submissions" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "kyc_submissions_reviewed_by_idx" ON "kyc_submissions" USING btree ("reviewed_by");--> statement-breakpoint
CREATE INDEX "ledger_accounts_owner_idx" ON "ledger_accounts" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "ledger_accounts_currency_idx" ON "ledger_accounts" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "ledger_entries_transaction_id_idx" ON "ledger_entries" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("account_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_idempotency_key_uq" ON "ledger_transactions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_transactions_ref_idx" ON "ledger_transactions" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "ledger_transactions_kind_idx" ON "ledger_transactions" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ledger_transactions_created_idx" ON "ledger_transactions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "legal_documents_current_uq" ON "legal_documents" USING btree ("type","locale") WHERE "legal_documents"."is_current";--> statement-breakpoint
CREATE INDEX "legal_documents_created_by_idx" ON "legal_documents" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "notifications_recipient_idx" ON "notifications" USING btree ("recipient_type","recipient_id");--> statement-breakpoint
CREATE INDEX "notifications_status_created_idx" ON "notifications" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_public_token_uq" ON "orders" USING btree ("public_token") WHERE "orders"."public_token" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "orders_client_idempotency_uq" ON "orders" USING btree ("client_id","idempotency_key") WHERE "orders"."idempotency_key" is not null;--> statement-breakpoint
CREATE INDEX "orders_client_created_idx" ON "orders" USING btree ("client_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_customer_created_idx" ON "orders" USING btree ("customer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_service_id_idx" ON "orders" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "orders_supplier_status_idx" ON "orders" USING btree ("supplier_id","status");--> statement-breakpoint
CREATE INDEX "orders_open_idx" ON "orders" USING btree ("dispatch_state","placed_at") WHERE "orders"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "orders_fingerprint_open_idx" ON "orders" USING btree ("fingerprint") WHERE "orders"."fingerprint" is not null and "orders"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "orders_verification_idx" ON "orders" USING btree ("completed_at") WHERE "orders"."verification_status" is not null;--> statement-breakpoint
CREATE INDEX "orders_api_key_id_idx" ON "orders" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "orders_currency_idx" ON "orders" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "orders_checkout_session_id_idx" ON "orders" USING btree ("checkout_session_id");--> statement-breakpoint
CREATE INDEX "orders_supplier_service_id_idx" ON "orders" USING btree ("supplier_service_id");--> statement-breakpoint
CREATE INDEX "orders_input_file_id_idx" ON "orders" USING btree ("input_file_id");--> statement-breakpoint
CREATE INDEX "orders_result_file_id_idx" ON "orders" USING btree ("result_file_id");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("id") WHERE "outbox_events"."processed_at" is null;--> statement-breakpoint
CREATE INDEX "outbox_events_processed_idx" ON "outbox_events" USING btree ("processed_at") WHERE "outbox_events"."processed_at" is not null;--> statement-breakpoint
CREATE INDEX "outbox_events_aggregate_idx" ON "outbox_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_gateways_code_uq" ON "payment_gateways" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_txn_uq" ON "payments" USING btree ("gateway_id","gateway_txn_id") WHERE "payments"."gateway_txn_id" is not null;--> statement-breakpoint
CREATE INDEX "payments_purpose_status_created_idx" ON "payments" USING btree ("purpose","status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_customer_id_idx" ON "payments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "payments_invoice_id_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payments_order_id_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_gateway_id_idx" ON "payments" USING btree ("gateway_id");--> statement-breakpoint
CREATE INDEX "payments_currency_idx" ON "payments" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "payments_receipt_file_id_idx" ON "payments" USING btree ("receipt_file_id");--> statement-breakpoint
CREATE INDEX "payments_reviewed_by_idx" ON "payments" USING btree ("reviewed_by");--> statement-breakpoint
CREATE INDEX "pricing_rules_target_idx" ON "pricing_rules" USING btree ("scope","target_id");--> statement-breakpoint
CREATE INDEX "pricing_rules_priority_idx" ON "pricing_rules" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "pricing_rules_group_id_idx" ON "pricing_rules" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "refunds_status_created_idx" ON "refunds" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "refunds_created_idx" ON "refunds" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "refunds_payment_id_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "refunds_order_id_idx" ON "refunds" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "refunds_customer_id_idx" ON "refunds" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "refunds_client_id_idx" ON "refunds" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "refunds_currency_idx" ON "refunds" USING btree ("currency");--> statement-breakpoint
CREATE INDEX "refunds_approved_by_idx" ON "refunds" USING btree ("approved_by");--> statement-breakpoint
CREATE INDEX "refunds_ledger_tx_id_idx" ON "refunds" USING btree ("ledger_tx_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reply_templates_shortcut_uq" ON "reply_templates" USING btree (lower("shortcut")) WHERE "reply_templates"."shortcut" is not null;--> statement-breakpoint
CREATE INDEX "reply_templates_created_by_idx" ON "reply_templates" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "risk_assessments_review_idx" ON "risk_assessments" USING btree ("created_at") WHERE "risk_assessments"."decision" = 'review' and "risk_assessments"."reviewed_at" is null;--> statement-breakpoint
CREATE INDEX "risk_assessments_order_id_idx" ON "risk_assessments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "risk_assessments_checkout_session_id_idx" ON "risk_assessments" USING btree ("checkout_session_id");--> statement-breakpoint
CREATE INDEX "risk_assessments_customer_id_idx" ON "risk_assessments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "risk_assessments_reviewed_by_idx" ON "risk_assessments" USING btree ("reviewed_by");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_uq" ON "roles" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "service_categories_name_uq" ON "service_categories" USING btree ("type",lower("name"));--> statement-breakpoint
CREATE INDEX "service_checks_component_checked_idx" ON "service_checks" USING btree ("component","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "service_checks_supplier_checked_idx" ON "service_checks" USING btree ("supplier_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "service_checks_gateway_id_idx" ON "service_checks" USING btree ("gateway_id");--> statement-breakpoint
CREATE INDEX "service_checks_checked_idx" ON "service_checks" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "service_client_prices_client_id_idx" ON "service_client_prices" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "service_client_prices_created_by_idx" ON "service_client_prices" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "service_group_prices_group_id_idx" ON "service_group_prices" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "service_listings_listed_idx" ON "service_listings" USING btree ("is_listed","sort");--> statement-breakpoint
CREATE INDEX "service_listings_public_title_idx" ON "service_listings" USING btree ("public_title");--> statement-breakpoint
CREATE INDEX "service_listings_og_file_id_idx" ON "service_listings" USING btree ("og_file_id");--> statement-breakpoint
CREATE INDEX "service_supplier_links_routing_idx" ON "service_supplier_links" USING btree ("service_id","priority");--> statement-breakpoint
CREATE INDEX "service_supplier_links_supplier_service_idx" ON "service_supplier_links" USING btree ("supplier_service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_code_uq" ON "services" USING btree (lower("code"));--> statement-breakpoint
CREATE INDEX "services_type_status_idx" ON "services" USING btree ("type","status");--> statement-breakpoint
CREATE INDEX "services_category_id_idx" ON "services" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "services_name_idx" ON "services" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_uq" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_subject_idx" ON "sessions" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "sessions_active_idx" ON "sessions" USING btree ("subject_type","subject_id") WHERE "sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_last_seen_idx" ON "sessions" USING btree ("last_seen_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_users_email_uq" ON "staff_users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "staff_users_role_id_idx" ON "staff_users" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "staff_users_status_idx" ON "staff_users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "staff_users_suspended_by_idx" ON "staff_users" USING btree ("suspended_by");--> statement-breakpoint
CREATE INDEX "staff_users_created_by_idx" ON "staff_users" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "supplier_api_logs_supplier_created_idx" ON "supplier_api_logs" USING btree ("supplier_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "supplier_api_logs_order_id_idx" ON "supplier_api_logs" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "supplier_services_available_idx" ON "supplier_services" USING btree ("supplier_id","is_available");--> statement-breakpoint
CREATE INDEX "supplier_services_supplier_name_idx" ON "supplier_services" USING btree ("supplier_id","name");--> statement-breakpoint
CREATE INDEX "suppliers_status_idx" ON "suppliers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "support_tickets_number_uq" ON "support_tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "support_tickets_requester_idx" ON "support_tickets" USING btree ("requester_type","requester_id");--> statement-breakpoint
CREATE INDEX "support_tickets_status_created_idx" ON "support_tickets" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_tickets_updated_idx" ON "support_tickets" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_tickets_sla_idx" ON "support_tickets" USING btree ("sla_due_at") WHERE "support_tickets"."status" not in ('resolved', 'closed');--> statement-breakpoint
CREATE INDEX "support_tickets_order_id_idx" ON "support_tickets" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "support_tickets_assignee_id_idx" ON "support_tickets" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "tac_catalog_brand_idx" ON "tac_catalog" USING btree ("brand");--> statement-breakpoint
CREATE INDEX "tax_rates_country_valid_idx" ON "tax_rates" USING btree ("country","valid_from" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" USING btree ("ticket_id","id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint_id_idx" ON "webhook_deliveries" USING btree ("endpoint_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_retry_idx" ON "webhook_deliveries" USING btree ("next_retry_at") WHERE "webhook_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_created_idx" ON "webhook_deliveries" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_deliveries_created_idx" ON "webhook_deliveries" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "webhook_endpoints_client_id_idx" ON "webhook_endpoints" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "withdrawal_requests_client_id_idx" ON "withdrawal_requests" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "withdrawal_requests_decided_by_idx" ON "withdrawal_requests" USING btree ("decided_by");