CREATE TABLE "credit_limit_raises" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "credit_limit_raises_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" bigint NOT NULL,
	"staff_id" bigint NOT NULL,
	"amount" numeric(18, 4) NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_limit_raises_amount_check" CHECK ("credit_limit_raises"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "credit_limit_raises" ADD CONSTRAINT "credit_limit_raises_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_limit_raises" ADD CONSTRAINT "credit_limit_raises_staff_id_staff_users_id_fk" FOREIGN KEY ("staff_id") REFERENCES "public"."staff_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_limit_raises_staff_created_idx" ON "credit_limit_raises" USING btree ("staff_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "credit_limit_raises_client_id_idx" ON "credit_limit_raises" USING btree ("client_id");