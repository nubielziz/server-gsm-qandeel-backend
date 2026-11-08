# P4a — follow-ups left open by earlier merges

Phase 4. Every route of the map is built; this feature closes the small gaps the merge notes recorded (PROGRESS "Notes for later
phases", MISMATCHES B166 and B168). No new route. Each item: the change, a test that fails without it, the docs it touches.

## Items

1. **Idempotency keys expire (B166).** `idempotency_keys` rows never expire and keep the replayed answer (delivered stock codes
   included). Add a daily job `idempotency_purge` on the `maintenance` queue (04:10 UTC; `job_runs` like the other scheduled jobs;
   `docs/queues.md`) that deletes the rows older than 7 days (`created_at`, the clock's time as a parameter, decision 031) and
   clears `orders.idempotency_key` of the orders placed more than 7 days ago, so a key is remembered for exactly the window and then
   free again for that merchant. Batches of at most 1000 rows per statement until none is left. State the 7-day window in the
   REST v1 contract descriptions of `POST /v1/orders` and `/v1/orders/bulk` (and the public OpenAPI). Tests: a key older than the
   window is free again (a new order, not a replay), a younger one still replays; the job run is recorded.
2. **A refused file order leaves no file (B166).** When a file order (Dhru `placefileorder`, REST v1 or portal file order) is
   refused or rolled back after its upload was stored, the stored object and its `files` row go (or the upload is stored only once
   the order commits, whichever fits the code). Never delete a file another order or request still points at. Tests for a refused
   placement (price changed, not enough credit) leaving no object and no row.
3. **Dhru `FILEDATA` is not cut at 1 MiB (B166).** The form body of `POST /api/index.php` is bound by the general 1 MiB limit, so a
   `placefileorder` with a larger file fails before the action runs. Let that route read a form body up to the file size limit the
   upload routes already allow (the same constant), behind the per-IP `upload` limiter that already guards large bodies read before
   the credentials (decision 021); every other route keeps 1 MiB. Test: a `placefileorder` with a file just over 1 MiB is placed; one
   over the file limit is refused with the Dhru error the action uses for a file that is too large.
4. **An idle supplier is not degraded (B168).** A supplier with no calls in the health window reads `unknown`, and the dashboard and
   System health count it as degraded. `unknown` must show as unknown (no recent calls), never as degraded or down, wherever the
   supplier status is summarised (dashboard supplier rows and attention items, System health). Match the console's status values
   (`src/features/dashboard` and `src/features/system-health` types in the frontend repo, read-only). Tests.
5. **The merchant portal origin in the development CORS default.** `PORTAL_BASE_URL` defaults to `http://localhost:5174`; add that
   origin to the development default of `CORS_ORIGINS` (never to production defaults). Test of the config default.

## Out of scope

Gateway health checks (B168: no definition of a gateway's health yet), the invoice PDF job, the gateway_clearing path of a
mismatched payment, the webhook delivery re-queue. Record anything else you find in the report instead of building it.
