ALTER TABLE "notification_templates" DROP CONSTRAINT "notification_templates_event_uq";--> statement-breakpoint
ALTER TABLE "notification_templates" DROP COLUMN "locale";--> statement-breakpoint
ALTER TABLE "notification_templates" ADD CONSTRAINT "notification_templates_event_uq" UNIQUE("event","channel","audience");