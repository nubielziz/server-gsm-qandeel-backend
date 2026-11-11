-- Feature 22: a listing already on the site was "published" when it was created; later switches set listed_at themselves.
UPDATE "service_listings" SET "listed_at" = "created_at" WHERE "is_listed" AND "listed_at" IS NULL;
