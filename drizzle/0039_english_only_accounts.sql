ALTER TABLE "clients" DROP CONSTRAINT "clients_locale_check";--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "locale";--> statement-breakpoint
ALTER TABLE "customers" DROP COLUMN "locale";--> statement-breakpoint
ALTER TABLE "reply_templates" DROP COLUMN "locale";