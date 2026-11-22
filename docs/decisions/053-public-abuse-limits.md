# 053: Limits of the public surfaces

Status: accepted, 2026-11-22 (feature 43). Amends decisions 018 (the request pipeline, the session lookups) and 021 (rate limiting).

**Context.** Several public flows did work, or sent mail, on behalf of anyone: the contact form filed a ticket under whoever owns a typed
email address and mailed the typed words to it; a marketing answer typed at a guest checkout counted for that address; uploads, merchant
webhook tests, incoming webhooks, `GET /health` and bulk API calls had no bound per owner, per merchant or per address; session cookies
that name nothing cost a database read each; a NUL character or an unpaired surrogate in request text made a database statement fail on one
branch only; the API server set no time bounds on a request.

**Decision.**
- **Request text.** A string anywhere in the path, the query or the body (an object key and a file part's name included) that holds the
  character U+0000 or an unpaired surrogate (a text that is not well-formed Unicode: a high surrogate with no low one after it, or a low one
  with no high one before it; a valid pair such as an emoji is fine) is refused with `422 VALIDATION_FAILED` on its field, before the handler
  runs; the Dhru `parameters` and `CUSTOMFIELD`, which arrive encoded, follow the same rule. The reason is that the database stores such a
  text in a text column (replaced) but refuses it in a JSON column, so one request would succeed on one branch of a handler and fail on
  another. The incoming webhooks (`/webhooks/*`) are not judged this way: their senders repeat a refused delivery, and their handlers read
  them field by field. What those handlers store from a body (event payloads, ids, texts) is written with U+0000 removed and each unpaired
  surrogate replaced by U+FFFD (one shared helper, `withoutForbiddenText`), so a correctly signed body that holds them is accepted as usual.
- **The contact form.** A ticket opened by typing an email address is unconfirmed until its link, which goes only to that address, is
  used: until then it is not listed in the account of the customer who owns the address, its live events do not reach that account, it is
  not in that customer's data export nor in the evidence of a dispute of their orders (one condition, `requesterProven()`, shared by every
  such read), and no satisfaction survey is sent; the anonymization of the customer still covers it like any other ticket; staff see a system note in the thread, and another when the address is confirmed. The receipt mail of
  every ticket holds the ticket number and the link and nothing a visitor typed. One address gets at most three new tickets an hour,
  also when the ticket is opened with an order link (counted for the order's customer).
- **Marketing consent.** A marketing answer counts once the customer's address is confirmed: an email-verification or sign-in link was used,
  an invitation was accepted, or a checkout of the customer was paid. Recovery mails and marketing campaigns use this consent, and no
  campaign of any purpose reaches a customer whose address was never confirmed.
- **Uploads.** The 5 MiB bound of the store and ticket uploads holds for the bytes read, whether or not a body declares its length. On the
  upload routes that sign in with a session cookie, a multipart body is read only when the request carries a live session of the route's
  audience; the `Content-Type` is read the way Fastify picks the body parser (leading whitespace dropped, any case), so a type that
  starts with a non-breaking space is judged as multipart too: the `415` of the routes that take no multipart body, the per-route
  bounds, the large-body count of the per-IP limit and this precheck all use one test. A session cookie that names no live session costs one point of a budget per client address and audience (300 a minute, the
  budget of unknown API keys); once it is used up, the address is answered `429` without a lookup, and unknown API keys are judged the same
  way. Quotas: a merchant not approved yet keeps at most 10 uploaded files (50 MiB); an approved merchant uploads at most 500 files (5 GiB)
  in 24 hours; a customer 30 files (100 MiB); one ticket link 20 files (50 MiB). A refusal is `422` on `file` with the code `quota`. A
  daily job deletes the stored files that nothing has used for 7 days; each delete is one statement that repeats the whole "nothing
  references it" test for that row, so only a reference that is not committed yet can race it (a file attached through an array column in
  the very moment its row is deleted, 7 days after its upload, is the residual).
- **Merchant webhooks.** A merchant sends at most 10 test deliveries an hour. An endpoint whose last 20 deliveries all failed is switched
  off and the merchant gets an email; a delivery that succeeds, or turning the endpoint on, starts the count again. Deliveries and supplier
  call logs are kept 90 days.
- **Probes and incoming webhooks.** `GET /health` answers from a check at most 3 seconds old, one check at a time. Incoming webhooks are
  counted per client address (600 a minute) before the route reads anything.
- **Bulk calls.** A REST v1 bulk placement and a Dhru `placeimeiorderbulk` cost one point of the key's per-minute limit per item, at most
  the whole limit. A Dhru bulk item id has 1 to 64 characters.
- **Server time bounds.** `HTTP_HEADERS_TIMEOUT_MS` (default 20 s) bounds the headers of a request and `HTTP_REQUEST_TIMEOUT_MS` (600 s) the
  whole request, body included; the boot refuses a headers bound that is not shorter than the request bound. The request bound lets the
  largest upload (25 MiB) finish at about 0.35 Mbit/s. A live stream's request ends with its headers and the stream only writes, so neither
  bound cuts it; a real-socket test holds a stream open past both. There is no bound on the silence of a connection: Bun resets that timer
  only on bytes that come in, never on bytes written, so it cuts every live stream and every long download at its bound (measured on
  Bun 1.4.4), and the two bounds above already close a connection that stays silent before its request is complete.
- Help votes are counted per address network (the /64 of an IPv6 address) and only for a published article; the IMEI retention runs until
  its backlog is done (at most 2 000 000 checks a night).

**Consequences.** The rules above are visible to clients only as refusals with existing codes (`422`, `429`, `401`, `413`), a switched-off
webhook endpoint with its email, a receipt with fixed wording, and tickets that join a customer's account once their link is used. The new
settings, limiters (`webhook-intake`, `webhook-test`), pipeline stage (`upload-session`), jobs (`upload_janitor`,
`webhook_delivery_retention`, `supplier_log_retention`), notification event (`webhook.endpoint_disabled`) and the columns
`support_tickets.requester_proven_at` and `webhook_endpoints.consecutive_failed_deliveries` are documented in `docs/queues.md`,
`docs/OPERATIONS.md` and the module READMEs. A marketing answer recorded before the address was confirmed counts after it; every marketing
mail carries the unsubscribe link. Amends decisions 018 (the pipeline stage, the session budget) and 021 (the limiters, the bulk points).
