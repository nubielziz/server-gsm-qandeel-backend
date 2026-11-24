-- Phase 9 of the expand migration of one account type (backend decision 064): the cutover of sign-in. There is one sign-in for every
-- account now, with one session cookie, so every session that is not a staff session ends and everyone signs in again (the rows stay:
-- the sign-in lock reads the familiar addresses of earlier sessions).
UPDATE "sessions"
   SET "revoked_at" = now(), "updated_at" = now()
 WHERE "subject_type" = 'account' AND "revoked_at" IS NULL;
--> statement-breakpoint
-- The open email links that must not work any more: every link sent to an old customer (it was made for the old shop sign-in) and every
-- link of an account that may not act (suspended, blocked or anonymized). The invitation and reset links of an active merchant stay usable.
UPDATE "auth_tokens"
   SET "used_at" = now(), "updated_at" = now()
 WHERE "subject_type" = 'account'
   AND "used_at" IS NULL
   AND ("subject_id" IN (SELECT "account_id" FROM "account_legacy_ids" WHERE "legacy_type" = 'customer')
        OR "subject_id" IN (SELECT "id" FROM "clients" WHERE "status" <> 'active'));
