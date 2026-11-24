-- Phase 8 of the expand migration of one account type (backend decision 064): the last statuses of the old merchant model. Nothing
-- activates a pending row any more (decision 062 suspended those it found); one that is still pending is suspended the same way, with
-- the same fixed reason, so the status check can be narrowed to active, suspended, blocked and anonymized (the generated statements after
-- this file, with the guest, erasure and rank checks).
UPDATE "clients"
   SET "status" = 'suspended',
       "suspended_at" = now(),
       "suspended_reason" = 'This account was never activated, so it was suspended. Staff can review it and reactivate it.',
       "suspended_by" = NULL,
       "updated_at" = now()
 WHERE "status" = 'pending';
