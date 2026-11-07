CREATE TABLE "idempotency_keys" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "idempotency_keys_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" bigint NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" integer NOT NULL,
	"response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_client_key_uq" UNIQUE("client_id","key"),
	CONSTRAINT "idempotency_keys_scope_check" CHECK ("idempotency_keys"."scope" in ('order', 'bulk'))
);
--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;