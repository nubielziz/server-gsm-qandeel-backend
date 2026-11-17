ALTER TABLE "content_pages" DROP CONSTRAINT "content_pages_slug_uq";--> statement-breakpoint
DROP INDEX "legal_documents_current_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "legal_documents_current_uq" ON "legal_documents" USING btree ("type") WHERE "legal_documents"."is_current";--> statement-breakpoint
ALTER TABLE "content_pages" DROP COLUMN "locale";--> statement-breakpoint
ALTER TABLE "help_articles" DROP COLUMN "locale";--> statement-breakpoint
ALTER TABLE "content_pages" ADD CONSTRAINT "content_pages_slug_uq" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_locale_check" CHECK ("legal_documents"."locale" = 'en' or not "legal_documents"."is_current");