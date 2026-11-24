-- Shop content trimmed (decision 068): landing pages, the TAC catalogue's admin routes and the search tools of the console are retired. One
-- check changes; the rest is data. Every statement can run twice and on an empty database. No table or column is dropped: `search_pins` and
-- `search_hidden_terms` stay, emptied and unread, until a later migration drops them, so an API of the release before never meets a missing table.
--
-- 1. Landing pages. A content page is a static page or a blog post. The old check goes first: it takes the table lock for the rest of the
--    transaction, so an API of the release before cannot insert a landing row between the delete and the new check. No foreign key points at
--    `content_pages`; the audit rows of a deleted page stay (history is append-only).
ALTER TABLE "content_pages" DROP CONSTRAINT "content_pages_kind_check";--> statement-breakpoint
DELETE FROM "content_pages" WHERE "kind" IN ('country', 'model', 'brand', 'carrier', 'tool');--> statement-breakpoint
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_kind_check" CHECK ("content_pages"."kind" in ('static', 'blog'));--> statement-breakpoint
-- 2. Pins. Nothing reads the table any more and the engine has no curation set from services schema version 2 on; the rows would only keep
--    old rules that nothing shows or erases.
DELETE FROM "search_pins";--> statement-breakpoint
-- 3. Hidden popular terms. The popular searches keep every other rule.
DELETE FROM "search_hidden_terms";--> statement-breakpoint
-- 4. `search.settings_changed` has no outbox route any more. A row nobody relayed yet would not block the relay, but it would be retried
--    every five minutes for ever with a warning: it is marked as handled, as migration 0065 did for the kinds decision 062 retired.
UPDATE "outbox_events"
   SET "processed_at" = now(),
       "updated_at" = now()
 WHERE "processed_at" IS NULL
   AND "type" = 'search.settings_changed';
-- Not here, on purpose: `search_synonyms` is not touched (the five starting synonyms of migration 0033 and any change staff made stay, read
-- only), and the engine needs no step (the services schema version is 2, so the worker's first reconcile rebuilds the index by itself).
