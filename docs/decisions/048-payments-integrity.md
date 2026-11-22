# 048: Payments integrity

Status: accepted (feature 38, 2026-11-21). Builds on 016, 023, 024, 025, 044 and 046.

## Context

Storefront orders and wallet top-ups are paid through hosted gateway pages and confirmed by signed gateway events. A confirmation could be
used with less proof than the money needs: an event that did not state its amount or currency counted as matching its quote; a storefront
order was created from the signed event alone; the hosted card page stayed payable for a day while the checkout's price lock lasts 30
minutes; a confirmation that could not pay its checkout was parked with no way out; an order-engine refund could pay out money the buyer
had already disputed with the card network; the gateway's checkout address and the buyer's return address were taken as given; a checkout
could open any number of payment pages; one order per checkout rested on a row lock alone; and a confirmation for a closed top-up invoice,
or a dispute event that arrived before its payment, left no record.

## Decision

1. **A confirmation states what was paid.** An amount or a currency the gateway's event does not state is a mismatch, never a match: a
   top-up goes to staff review (and is never credited from it), a storefront payment is held.
2. **The gateway's own record decides a storefront capture.** Before the order is created, the record of the payment is read from the
   gateway (the card driver's PaymentIntent or Checkout Session, the crypto driver's invoice). It must say paid, for the quoted amount and
   currency, and for this checkout: the card page's payment carries the checkout's reference (`metadata[reference]`), and a record that
   names another checkout holds the payment before any other check, whatever else the record says: it is that checkout's payment, so
   nothing is sent back, the reference is not kept, and that checkout's own confirmation still captures (a record without the reference,
   from a page opened before this rule, passes). When the record
   cannot be read, the webhook answers 502 so that the gateway delivers the event again; when the confirmation is 24 hours old (its own
   time, else when the payment was opened) and the record still cannot be read, the payment is held for staff. A record that does not say
   paid, or says another amount or currency, holds the payment. A record whose latest charge was refunded in full or in part since, or
   is disputed, is not a payment to use as quoted: the payment is held and nothing is sent back (the money already went back or is
   contested). The automatic credit of a card top-up reads the same record, once, before it credits (a job nobody waits on, so the read
   has the time of any other gateway call, not the short limit of the webhook): it must say paid, show nothing
   refunded or disputed since, show the invoice's amount and currency as received and, when it states the reference its checkout was
   opened with, name this invoice; any difference sends the top-up to staff review with a note that names it (a record without a
   reference passes on status, amount and currency). Top-ups of other automatic gateways keep the status check of the job.
3. **The price lock holds at the gateway too.** The hosted card page closes 30 minutes after the checkout's price lock ends (and never
   sooner than 31 minutes after it was opened: the gateway's minimum is 30). A payment made later than that, judged on the time the buyer
   paid (the gateway's charge time, else the event's own time, else when the payment was opened; never when the event was processed), is
   not used at the old price: its order is placed held and refunded at once through the gateway, and the buyer gets the order-failed mail;
   when the method cannot refund (crypto, a gateway without refunds) the order waits in the risk queue for staff. Crypto follows the same
   rule.
4. **A held payment always has a way out.** A confirmation that cannot pay its checkout (another amount or currency, no stated amount, no
   checkout, a record that says not paid or names another checkout, a reference that belongs to another payment) creates no order and
   posts nothing. When money arrived for this payment (never for a record that names another checkout) and the gateway can refund, the
   whole charge is sent back at once (a refund without an order, sent by
   the refund job). Until its money is back a held payment is a finding of the money integrity check ("Every confirmed payment has an
   entry"), which raises the ledger mismatch alert when such an alert rule exists; staff close it with
   `POST /admin/held-payments/:id/close` (paid back by hand, or no money received). The hold records, with the event it stores, whether
   the gateway's record showed money received for this payment (another amount or currency, no checkout, money refunded or disputed
   since); such a payment can only be closed as paid back, so money that is still there never leaves the integrity check. A record that
   says not paid, could not be checked or names another checkout records no money received; a payment held before the mark existed
   accepts both outcomes. A return the gateway fails after it had completed is failed again, so its payment is a finding again. A
   returned held payment is not booked, and neither is the gateway's fee on it.
5. **Only exact amounts are charged.** While an active storefront card method exists, a currency's decimals may not exceed what it can
   charge exactly; an amount the chosen method cannot charge exactly is refused before a page opens.
6. **A disputed payment is never paid out by the order engine.** A staff or supplier rejection, or a risk refund, of an order whose payment
   is disputed or charged back opens a refund request for staff and says so on the timeline; the request can be approved once the dispute
   is won. A refund approved before the dispute is not sent to the gateway while the dispute is open: it fails with a note and staff send it
   again once the dispute is closed. When the chargeback is booked (the dispute is lost), every refund of the payment that has not
   completed at the gateway (a request, a refund waiting to be sent, one that failed) is closed as not sent ("Not sent: the payment was
   charged back.", status `rejected`, a timeline line) and the journal it posted is reversed in the same transaction (a mirrored
   transaction, key `reverse:<journal id>`): the card network returned the money, so the books show it leaving once. A refund the
   gateway completed before stays (the gateway paid both); one the gateway acknowledged and has not answered yet waits for its answer.
   Only the refunds that are closed are locked. The reports leave a reversed refund journal and its reversal out: together they returned
   nothing.
7. **Addresses are checked.** The checkout address a gateway returns must be an https address. The return address of a storefront payment
   must be on one of the shop's own origins (`STORE_BASE_URL`, `PORTAL_BASE_URL`, or an origin of `SHOP_ORIGINS`).
8. **A checkout keeps at most three live payment pages.** A fourth is `429 RATE_LIMITED` with `Retry-After: 60`.
9. **One order per checkout session** is a unique index.
10. **Nothing confirmed is dropped.** A confirmation of a top-up invoice that is paid or void is recorded for staff review and never
    credited. A dispute event that names a payment or a dispute not recorded yet is answered 503, so the gateway delivers it again once
    the payment or the opening is recorded; once the event is 24 hours old (or does not say when it was made) it is acknowledged, logged
    and reported for staff, and a held payment's review note records the dispute. A dispute event the database could not apply because it
    met another change at the same moment (a loss locks the payment and then its refunds, a refund's settlement the refund and then its
    payment) writes nothing and is answered 503 too.

## Consequences

- A gateway outage delays storefront orders (the gateway retries) instead of creating them unchecked; the card-details risk signal of a
  failed read no longer occurs for storefront payments (their card details come from the same record).
- Staff see held storefront payments in the integrity check, not on a page of their own yet; a console screen and a buyer mail for a
  returned payment are later work.
- A payment confirmed in the 30 minutes after the lock is still used at the locked price: the owner accepts that window.
- Refund rows without an order exist (automatic and hand returns of held payments); the Refunds page and the reports leave them out, and a
  failed automatic return is not retried from the console.
- A won dispute after staff accepted the loss is logged for staff; the booked loss stays.
- A refund closed because its payment was charged back cannot be sent again; its reversal stays in the journal next to it, and the VAT
  report leaves both out.
