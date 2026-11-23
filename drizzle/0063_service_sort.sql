-- The position of a service among the services of its category (decision 063). Staff set it from the console's service page; the lists
-- merchants and API clients read are ordered by category position, then this number, then the name. Additive: every service starts at 0,
-- which keeps the name order those lists had, and nothing is backfilled.
ALTER TABLE "services" ADD COLUMN "sort" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_sort_check" CHECK ("services"."sort" >= 0 and "services"."sort" <= 1000000);