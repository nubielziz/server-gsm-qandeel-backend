CREATE TABLE "listed_prices" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "listed_prices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"client_id" bigint NOT NULL,
	"service_id" bigint NOT NULL,
	"price" numeric(18, 4) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"listed_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "listed_prices_uq" UNIQUE("client_id","service_id"),
	CONSTRAINT "listed_prices_price_check" CHECK ("listed_prices"."price" >= 0),
	CONSTRAINT "listed_prices_currency_check" CHECK ("listed_prices"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "listed_prices" ADD CONSTRAINT "listed_prices_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listed_prices" ADD CONSTRAINT "listed_prices_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listed_prices_service_id_idx" ON "listed_prices" USING btree ("service_id");