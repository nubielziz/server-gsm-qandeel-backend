-- Feature 28 (support as a live chat): the seen marks of both sides, the newest message of each side, the reply-mail sweep's columns and
-- the channel a public staff message was delivered on.
--   * support_tickets gains requester_seen_message_id/_at, staff_seen_message_id/_at, last_requester_message_id, last_staff_message_id,
--     reply_mail_due_at (indexed where set: the sweep reads it every minute) and reply_mailed_message_id; all nullable, no default.
--   * ticket_messages gains notify_channel (`email` or `telegram` on a public staff message, else null).
--   * back-fill: last_* from the thread, both seen marks and reply_mailed_message_id set to them (old tickets are neither unread nor
--     mailed again), and every existing public staff message is marked `email`.
ALTER TABLE "support_tickets" ADD COLUMN "requester_seen_message_id" bigint;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "requester_seen_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "staff_seen_message_id" bigint;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "staff_seen_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "last_requester_message_id" bigint;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "last_staff_message_id" bigint;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "reply_mail_due_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "reply_mailed_message_id" bigint;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD COLUMN "notify_channel" text;--> statement-breakpoint
CREATE INDEX "support_tickets_reply_mail_due_idx" ON "support_tickets" USING btree ("reply_mail_due_at") WHERE "support_tickets"."reply_mail_due_at" is not null;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_notify_channel_check" CHECK ("ticket_messages"."notify_channel" in ('email', 'telegram'));--> statement-breakpoint
UPDATE "support_tickets" AS t
SET "last_requester_message_id" = m.last_requester, "last_staff_message_id" = m.last_staff
FROM (
  SELECT "ticket_id",
    max("id") FILTER (WHERE "author_type" IN ('customer', 'client') AND NOT "is_internal") AS last_requester,
    max("id") FILTER (WHERE "author_type" = 'staff' AND NOT "is_internal") AS last_staff
  FROM "ticket_messages"
  GROUP BY "ticket_id"
) AS m
WHERE m."ticket_id" = t."id";--> statement-breakpoint
UPDATE "support_tickets"
SET "requester_seen_message_id" = "last_staff_message_id",
  "staff_seen_message_id" = "last_requester_message_id",
  "reply_mailed_message_id" = "last_staff_message_id"
WHERE "last_staff_message_id" IS NOT NULL OR "last_requester_message_id" IS NOT NULL;--> statement-breakpoint
UPDATE "ticket_messages" SET "notify_channel" = 'email' WHERE "author_type" = 'staff' AND NOT "is_internal";
