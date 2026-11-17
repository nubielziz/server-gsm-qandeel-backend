-- Feature 30, English only (decision 039, plan docs/briefs/30-english-only.md section 4.3): the data step before the schema steps
-- 0036-0039. It deletes the content in other languages, retires the legal versions people accepted, remembers the old addresses
-- and rewrites the campaigns. Every pending migration runs in one transaction (src/infra/db/migrate.ts), so a refusal here
-- leaves the database as it was. No outbox event, no cache invalidation, no inbox recount (plan section 4.3).
--
-- 1. The guard: never delete content that existed before this run without an export of it (scripts/english-only-export.ts).
DO $$
DECLARE
  live jsonb;
  marker record;
  missing text;
BEGIN
  -- A test database holds nothing to keep (test/support/db.ts truncates it). A test forces the guard with
  -- ALTER DATABASE <name> SET gsm.english_only_guard = 'on'.
  IF current_database() ~ '_test$' AND coalesce(current_setting('gsm.english_only_guard', true), '') <> 'on' THEN RETURN; END IF;

  -- Retiring the only version in force of a document would leave checkout with nothing to agree to.
  SELECT string_agg(DISTINCT d.type, ', ') INTO missing FROM legal_documents d
   WHERE d.is_current AND d.locale <> 'en'
     AND NOT EXISTS (SELECT 1 FROM legal_documents e WHERE e.type = d.type AND e.locale = 'en' AND e.is_current);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'English only (0035): publish an English version of these documents first: %', missing;
  END IF;

  -- The export script (scripts/english-only-export.ts, COUNTS_SQL) runs this same expression; keep the two texts equal.
  live := jsonb_build_object(
    -- rows that migrations 0023/0025/0027 inserted earlier in this same run are not content (a fresh database)
    'notification_templates', (SELECT count(*) FROM notification_templates WHERE locale <> 'en'
                                 AND created_at < date_trunc('milliseconds', transaction_timestamp())),
    'service_listings',       (SELECT count(*) FROM service_listings   WHERE locale <> 'en'),
    'content_pages',          (SELECT count(*) FROM content_pages      WHERE locale <> 'en'),
    'help_articles',          (SELECT count(*) FROM help_articles      WHERE locale <> 'en'),
    'reply_templates',        (SELECT count(*) FROM reply_templates    WHERE locale <> 'en'),
    'legal_documents',        (SELECT count(*) FROM legal_documents    WHERE locale <> 'en'),
    'customers',              (SELECT count(*) FROM customers          WHERE locale <> 'en'),
    'clients',                (SELECT count(*) FROM clients            WHERE locale <> 'en'),
    'service_categories',     (SELECT count(*) FROM service_categories WHERE name_ar <> ''),
    'notification_campaigns', (SELECT count(*) FROM notification_campaigns
                                WHERE content ? 'ar' OR audience #> '{customers,locales}' IS NOT NULL),
    'canonical_urls',         (SELECT count(*) FROM content_pages
                                WHERE locale = 'en' AND canonical_url ~ '^(https?://[^/]+)?/ar(/|$|\?|#)'));
  IF NOT EXISTS (SELECT 1 FROM jsonb_each_text(live) WHERE value::bigint > 0) THEN RETURN; END IF;

  SELECT result, started_at INTO marker FROM job_runs
   WHERE job = 'english_only_export' AND status = 'succeeded' ORDER BY id DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'English only (0035): this database holds content the migration deletes (%). Run "bun scripts/english-only-export.ts" first (docs/OPERATIONS.md, release 30).', live;
  END IF;
  IF marker.result -> 'counts' IS DISTINCT FROM live THEN
    RAISE EXCEPTION 'English only (0035): the export is out of date (exported %, now %). Run it again.', marker.result -> 'counts', live;
  END IF;
  -- content edited after the export (same count, other text): the five content tables, legal documents and campaigns, and
  -- the two other texts the release deletes (an Arabic category name, an English page's /ar canonical address). The saved
  -- language of people is left to the count: their rows move at every sign-in, and the value has no use after the release.
  IF EXISTS (SELECT 1 FROM notification_templates WHERE locale <> 'en' AND updated_at > marker.started_at
                AND created_at < date_trunc('milliseconds', transaction_timestamp()))   -- the rows the count reads
     OR EXISTS (SELECT 1 FROM service_listings WHERE locale <> 'en' AND updated_at > marker.started_at)
     OR EXISTS (SELECT 1 FROM content_pages    WHERE locale <> 'en' AND updated_at > marker.started_at)
     OR EXISTS (SELECT 1 FROM help_articles    WHERE locale <> 'en' AND updated_at > marker.started_at)
     OR EXISTS (SELECT 1 FROM reply_templates  WHERE locale <> 'en' AND updated_at > marker.started_at)
     OR EXISTS (SELECT 1 FROM legal_documents  WHERE locale <> 'en' AND updated_at > marker.started_at)
     OR EXISTS (SELECT 1 FROM notification_campaigns
                 WHERE (content ? 'ar' OR audience #> '{customers,locales}' IS NOT NULL) AND updated_at > marker.started_at)
     OR EXISTS (SELECT 1 FROM service_categories WHERE name_ar <> '' AND updated_at > marker.started_at)
     OR EXISTS (SELECT 1 FROM content_pages
                 WHERE locale = 'en' AND canonical_url ~ '^(https?://[^/]+)?/ar(/|$|\?|#)' AND updated_at > marker.started_at) THEN
    RAISE EXCEPTION 'English only (0035): content changed after the export. Run it again.';
  END IF;
END $$;
--> statement-breakpoint
-- 2. Old addresses (plan section 4.5): only slugs that no English row of the same kind uses.
INSERT INTO legacy_slugs (kind, slug, service_id)
SELECT 'service', l.slug, l.service_id FROM service_listings l
 WHERE l.locale <> 'en' AND NOT EXISTS (SELECT 1 FROM service_listings e WHERE e.locale = 'en' AND e.slug = l.slug)
ON CONFLICT (kind, slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO legacy_slugs (kind, slug)
SELECT 'page', p.slug FROM content_pages p
 WHERE p.locale <> 'en' AND p.status IN ('published', 'noindex')
   AND NOT EXISTS (SELECT 1 FROM content_pages e WHERE e.locale = 'en' AND e.slug = p.slug)
ON CONFLICT (kind, slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO legacy_slugs (kind, slug)   -- a help address starts with the article id (domain/help-slug.ts)
SELECT 'help', h.id::text FROM help_articles h WHERE h.locale <> 'en' AND h.is_published
ON CONFLICT (kind, slug) DO NOTHING;
--> statement-breakpoint
-- 3. Campaigns (plan section 4.6): EVERY campaign, whatever its status, whose customer audience named no English reader. The audit
--    rows and the change read the same snapshot. A finished one is included: left with only its filter removed it would read
--    "all customers", and the console copies a stored audience into a new draft.
WITH hit AS (
  SELECT id, status IN ('scheduled', 'queued', 'sending') AS running FROM notification_campaigns
   WHERE jsonb_typeof(audience #> '{customers,locales}') = 'array'
     AND NOT (audience #> '{customers,locales}') ? 'en'
), noted AS (
  INSERT INTO audit_logs (actor_type, actor_name, action, entity_type, entity_id, entity_label, before, after)
  SELECT 'system', '',
         CASE WHEN hit.running THEN 'cancelled campaign (English only)' ELSE 'removed the customer audience (English only)' END,
         'notification_campaign', c.id, c.name,
         jsonb_build_object('status', c.status, 'audience', c.audience),
         jsonb_build_object('status', CASE WHEN hit.running THEN 'cancelled' ELSE c.status END, 'audience', c.audience - 'customers')
    FROM notification_campaigns c JOIN hit USING (id)
)
UPDATE notification_campaigns c
   SET status        = CASE WHEN hit.running THEN 'cancelled' ELSE c.status END,
       cancelled_at  = CASE WHEN hit.running THEN now() ELSE c.cancelled_at END,
       fanout_cursor = CASE WHEN hit.running THEN NULL ELSE c.fanout_cursor END,  -- as cancel() writes; cancelled_by stays NULL (the system)
       audience      = c.audience - 'customers',
       updated_at    = now()
  FROM hit WHERE c.id = hit.id;
--> statement-breakpoint
-- What still has the key listed 'en': those campaigns keep their customers and lose only the filter.
UPDATE notification_campaigns SET audience = audience #- '{customers,locales}' WHERE audience #> '{customers,locales}' IS NOT NULL;
--> statement-breakpoint
UPDATE notification_campaigns SET content = content -> 'en' WHERE content ? 'en';   -- { en: {title, body}, ar? } -> { title, body }
--> statement-breakpoint
-- 4. Legal documents (plan section 4.4): one audit row per version that stays as history, then retire, then delete what nobody
--    accepted.
INSERT INTO audit_logs (actor_type, actor_name, action, entity_type, entity_id, entity_label, before, after)
SELECT 'system', '', 'retired legal document (English only)', 'legal', d.id, d.type || ' ' || d.version,
       jsonb_build_object('isCurrent', d.is_current, 'locale', d.locale), jsonb_build_object('isCurrent', false, 'locale', d.locale)
  FROM legal_documents d
 WHERE d.locale <> 'en' AND EXISTS (SELECT 1 FROM consent_records c WHERE c.legal_document_id = d.id);
--> statement-breakpoint
UPDATE legal_documents SET is_current = false, updated_at = now() WHERE locale <> 'en' AND is_current;
--> statement-breakpoint
DELETE FROM legal_documents d
 WHERE d.locale <> 'en' AND NOT EXISTS (SELECT 1 FROM consent_records c WHERE c.legal_document_id = d.id);
--> statement-breakpoint
-- 5. Content in other languages (no table references these rows: audit A3 section 0.7).
DELETE FROM service_listings       WHERE locale <> 'en';
--> statement-breakpoint
DELETE FROM content_pages          WHERE locale <> 'en';
--> statement-breakpoint
DELETE FROM help_articles          WHERE locale <> 'en';
--> statement-breakpoint
DELETE FROM reply_templates        WHERE locale <> 'en';
--> statement-breakpoint
DELETE FROM notification_templates WHERE locale <> 'en';
--> statement-breakpoint
UPDATE content_pages SET canonical_url = NULL WHERE canonical_url ~ '^(https?://[^/]+)?/ar(/|$|\?|#)';
