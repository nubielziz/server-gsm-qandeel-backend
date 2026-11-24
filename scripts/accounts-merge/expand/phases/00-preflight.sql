-- Phase 0, the preflight of the expand migration of one account type (backend decision 064). It only reads: every check below is a
-- SELECT, and when any of them finds a row the block raises with ERRCODE check_violation and CONSTRAINT accounts_merge_preflight, so the
-- whole migration rolls back (one transaction) and nothing changes. The message names codes and ids only, never an email:
-- 'accounts merge stopped, nothing changed: <code> <ids>; ...' with the first 50 findings and their count.
-- scripts/accounts-merge-check.ts runs this same block in a READ ONLY transaction before the release (it finds it by its markers).
-- Approved pairs (a merchant and a customer with a login that share an email and become one account) come from the settings row
-- accountsMerge.approvedPairs, which only that script writes; without the row no pair is merged.
-- On an empty database every check finds nothing.
DO $$
DECLARE
  approvals jsonb;
  pair_clients bigint[] := '{}';
  pair_customers bigint[] := '{}';
  findings text[] := '{}';
BEGIN
  -- The approved pairs: a list of {"clientId", "customerId", "action": "one_account"}; an entry of another shape is a stale approval (E6).
  SELECT s.value INTO approvals FROM settings s WHERE s.key = 'accountsMerge.approvedPairs';
  IF approvals IS NOT NULL AND jsonb_typeof(approvals) <> 'array' THEN
    findings := findings || ARRAY['E6 approvals not a list'];
  ELSIF approvals IS NOT NULL THEN
    SELECT coalesce(array_agg(CASE WHEN v.ok THEN (e.item ->> 'clientId')::bigint END ORDER BY e.n) FILTER (WHERE v.ok), '{}'),
           coalesce(array_agg(CASE WHEN v.ok THEN (e.item ->> 'customerId')::bigint END ORDER BY e.n) FILTER (WHERE v.ok), '{}'),
           findings || coalesce(array_agg(format('E6 approval entry %s', e.n) ORDER BY e.n) FILTER (WHERE NOT v.ok), '{}')
      INTO pair_clients, pair_customers, findings
      FROM jsonb_array_elements(approvals) WITH ORDINALITY AS e(item, n)
      CROSS JOIN LATERAL (
        SELECT jsonb_typeof(e.item) = 'object'
           AND coalesce(e.item ->> 'clientId' ~ '^[1-9][0-9]{0,17}$' AND jsonb_typeof(e.item -> 'clientId') = 'number', false)
           AND coalesce(e.item ->> 'customerId' ~ '^[1-9][0-9]{0,17}$' AND jsonb_typeof(e.item -> 'customerId') = 'number', false)
           AND coalesce(e.item ->> 'action' = 'one_account', false) AS ok
      ) AS v;
  END IF;

  -- E6 stale approval: a merchant or a customer named twice, a pair whose rows are gone, whose emails differ, or whose customer has no login.
  findings := findings || ARRAY(
    SELECT format('E6 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) WITH ORDINALITY AS p(client_id, customer_id, n)
      LEFT JOIN clients m ON m.id = p.client_id
      LEFT JOIN customers c ON c.id = p.customer_id
     WHERE m.id IS NULL OR c.id IS NULL OR lower(m.email) <> lower(c.email) OR NOT c.has_account
        OR (SELECT count(*) FROM unnest(pair_clients) AS x(id) WHERE x.id = p.client_id) > 1
        OR (SELECT count(*) FROM unnest(pair_customers) AS x(id) WHERE x.id = p.customer_id) > 1
     ORDER BY p.n);

  -- E1 wallet: the customer of an approved pair holds a store balance or a frozen store wallet. A migration cannot post money; a wallet
  -- whose history ends at zero is allowed (it becomes the merchant's inactive store wallet).
  findings := findings || ARRAY(
    SELECT format('E1 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
     WHERE EXISTS (SELECT 1 FROM ledger_accounts la
                    WHERE la.owner_type = 'customer' AND la.owner_id = p.customer_id
                      AND (la.balance <> 0 OR la.frozen_at IS NOT NULL))
     ORDER BY p.customer_id);

  -- E2 money in flight: an open top-up invoice, a pending top-up payment, an open dispute of a top-up, or a waiting refund to the store
  -- balance of the customer of an approved pair (each would credit or debit a wallet whose owner the migration moves); or an order of that
  -- customer still in progress (pending or processing) or completed with its verification requested, or a checkout it opened signed in
  -- that is still open: the merge moves them to an account of the merchant kind, the crossing the rank change refuses with live_order and
  -- open_checkout (a refund of such an order would credit the merchant wallet, and a checkout paid later would make a shop order for it).
  findings := findings || ARRAY(
    SELECT format('E2 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
     WHERE EXISTS (SELECT 1 FROM invoices i
                    WHERE i.customer_id = p.customer_id AND i.kind = 'topup' AND i.status = 'open')
        OR EXISTS (SELECT 1 FROM payments pm LEFT JOIN invoices i ON i.id = pm.invoice_id
                    WHERE pm.purpose = 'topup' AND pm.status = 'pending'
                      AND p.customer_id IN (pm.customer_id, i.customer_id))
        OR EXISTS (SELECT 1 FROM disputes d JOIN payments pm ON pm.id = d.payment_id LEFT JOIN invoices i ON i.id = pm.invoice_id
                    WHERE pm.purpose = 'topup' AND d.status IN ('needs_response', 'under_review')
                      AND p.customer_id IN (d.customer_id, pm.customer_id, i.customer_id))
        OR EXISTS (SELECT 1 FROM refunds r JOIN payments pm ON pm.id = r.payment_id
                    WHERE pm.method_type = 'balance' AND r.status IN ('requested', 'processing')
                      AND p.customer_id IN (r.customer_id, pm.customer_id))
        OR EXISTS (SELECT 1 FROM orders o
                    WHERE o.customer_id = p.customer_id
                      AND (o.status IN ('pending', 'processing')
                           OR (o.status = 'completed' AND o.verification_status = 'requested')))
        OR EXISTS (SELECT 1 FROM checkout_sessions cs
                    WHERE cs.customer_id = p.customer_id AND cs.opened_signed_in AND cs.status = 'open' AND cs.expires_at > now())
     ORDER BY p.customer_id);

  -- E3 status: the two rows of an approved pair do not have the same status (a pending merchant counts as suspended), or the customer is
  -- blocked or anonymized.
  findings := findings || ARRAY(
    SELECT format('E3 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
      JOIN clients m ON m.id = p.client_id
      JOIN customers c ON c.id = p.customer_id
     WHERE c.status IN ('blocked', 'anonymized')
        OR (CASE WHEN m.status = 'pending' THEN 'suspended' ELSE m.status END) <> c.status
     ORDER BY p.customer_id);

  -- E4 privacy: the customer of an approved pair has a data request that is not finished.
  findings := findings || ARRAY(
    SELECT format('E4 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
     WHERE EXISTS (SELECT 1 FROM data_requests dr
                    WHERE dr.customer_id = p.customer_id AND dr.status IN ('open', 'in_progress'))
     ORDER BY p.customer_id);

  -- E5 login pair: a merchant and a customer with a login share an email and the owner did not approve them as one account. Only one row
  -- with a login may hold an email after the migration. An anonymized customer is not a pair: its copy gets a new, unused address.
  findings := findings || ARRAY(
    SELECT format('E5 client %s customer %s', m.id, c.id)
      FROM clients m
      JOIN customers c ON lower(c.email) = lower(m.email)
     WHERE c.has_account AND c.status <> 'anonymized'
       AND NOT EXISTS (SELECT 1 FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
                        WHERE p.client_id = m.id AND p.customer_id = c.id)
     ORDER BY m.id, c.id);

  -- E7 invoice key: the two rows of an approved pair used the same idempotency key on an invoice; after the merge both invoices belong to
  -- one account, where the key must be unique (invoices_account_key_uq).
  findings := findings || ARRAY(
    SELECT format('E7 client %s customer %s', p.client_id, p.customer_id)
      FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
     WHERE EXISTS (SELECT 1 FROM invoices a JOIN invoices b ON b.idempotency_key = a.idempotency_key
                    WHERE a.client_id = p.client_id AND b.customer_id = p.customer_id AND a.idempotency_key IS NOT NULL)
     ORDER BY p.customer_id);

  -- G1 outbox: an event of the old customer family is still waiting; its handler is gone after the release, so the worker must drain it.
  findings := findings || ARRAY(
    SELECT format('G1 outbox_events %s', o.id)
      FROM outbox_events o
     WHERE o.processed_at IS NULL AND (o.aggregate_type = 'customers' OR o.payload ? 'customerId')
     ORDER BY o.id);

  -- G2 orphan: a (type, id) pair that the migration rewrites names a merchant or a customer that does not exist, or a file names an owner
  -- kind no one writes; such a row cannot be given an account.
  findings := findings || ARRAY(
    SELECT format('G2 %s %s', x.tbl, x.id)
      FROM (
        SELECT 'sessions' AS tbl, r.id, r.subject_type AS kind, r.subject_id AS ref FROM sessions r
        UNION ALL SELECT 'auth_tokens', r.id, r.subject_type, r.subject_id FROM auth_tokens r
        UNION ALL SELECT 'ledger_accounts', r.id, r.owner_type, r.owner_id FROM ledger_accounts r
        UNION ALL SELECT 'notifications', r.id, r.recipient_type, r.recipient_id FROM notifications r
        UNION ALL SELECT 'notification_inbox', r.id, r.recipient_type, r.recipient_id FROM notification_inbox r
        UNION ALL SELECT 'support_tickets', r.id, r.requester_type, r.requester_id FROM support_tickets r
        UNION ALL SELECT 'ticket_messages', r.id, r.author_type, r.author_id FROM ticket_messages r
        UNION ALL SELECT 'consent_records', r.id, r.subject_type, r.subject_id FROM consent_records r
        UNION ALL SELECT 'files', r.id, r.owner_type, r.owner_id FROM files r
        UNION ALL SELECT 'refunds', r.id, r.requested_by_type, r.requested_by_id FROM refunds r
        UNION ALL SELECT 'alert_events', r.id, r.subject_type, r.subject_id FROM alert_events r
        UNION ALL
        SELECT 'notification_campaigns', c.id, person ->> 'type', CASE WHEN person ->> 'id' ~ '^[0-9]{1,18}$' THEN (person ->> 'id')::bigint END
          FROM notification_campaigns c
          CROSS JOIN LATERAL (VALUES ('include'), ('exclude')) AS k(list)
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.audience -> k.list) = 'array' THEN c.audience -> k.list ELSE '[]'::jsonb END) AS e(person)
      ) AS x
     WHERE (x.kind = 'client' AND NOT EXISTS (SELECT 1 FROM clients m WHERE m.id = x.ref))
        OR (x.kind = 'customer' AND NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = x.ref))
        OR (x.tbl = 'files' AND x.kind NOT IN ('client', 'customer', 'staff'))
     GROUP BY x.tbl, x.id
     ORDER BY x.tbl, x.id);

  -- G3 door: an order whose door does not match its buyer (a shop order of a merchant, or a merchant order without one); the new door
  -- check would refuse it.
  findings := findings || ARRAY(
    SELECT format('G3 orders %s', o.id)
      FROM orders o
     WHERE (o.source = 'store') <> (o.client_id IS NULL)
     ORDER BY o.id);

  -- G4 owner: an invoice without a merchant or a customer, or a payment or a dispute whose owner cannot be found; each needs an account.
  findings := findings || ARRAY(
    SELECT format('G4 %s %s', x.tbl, x.id)
      FROM (
        SELECT 'invoices' AS tbl, i.id FROM invoices i WHERE i.client_id IS NULL AND i.customer_id IS NULL
        UNION ALL
        SELECT 'payments', pm.id FROM payments pm
         WHERE pm.customer_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = pm.invoice_id AND (i.client_id IS NOT NULL OR i.customer_id IS NOT NULL))
        UNION ALL
        SELECT 'disputes', d.id FROM disputes d JOIN payments pm ON pm.id = d.payment_id
         WHERE d.customer_id IS NULL AND pm.customer_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = pm.invoice_id AND (i.client_id IS NOT NULL OR i.customer_id IS NOT NULL))
      ) AS x
     ORDER BY x.tbl, x.id);

  -- G5 rank kind: a rank of a kind other than merchant (b2b) and retail (b2c_retail); the kinds are closed after the migration.
  findings := findings || ARRAY(
    SELECT format('G5 client_groups %s', g.id) FROM client_groups g WHERE g.kind NOT IN ('b2b', 'b2c_retail') ORDER BY g.id);

  -- G6 refund refs: a refund of a customer without a payment, or whose customer is not the owner of its payment; the backfill gives every
  -- refund with a payment the account of that payment.
  findings := findings || ARRAY(
    SELECT format('G6 refunds %s', r.id)
      FROM refunds r
      LEFT JOIN payments pm ON pm.id = r.payment_id
      LEFT JOIN invoices i ON i.id = pm.invoice_id
     WHERE r.customer_id IS NOT NULL
       AND (pm.id IS NULL
            OR (coalesce(pm.customer_id, i.customer_id) IS DISTINCT FROM r.customer_id
                AND NOT EXISTS (SELECT 1 FROM unnest(pair_clients, pair_customers) AS p(client_id, customer_id)
                                 WHERE pm.customer_id IS NULL AND p.client_id = i.client_id AND p.customer_id = r.customer_id)))
     ORDER BY r.id);

  -- G7 campaign: a campaign is being sent; its stored fan-out position names old recipient kinds, so it must finish or be cancelled first.
  findings := findings || ARRAY(
    SELECT format('G7 notification_campaigns %s', c.id)
      FROM notification_campaigns c WHERE c.status IN ('queued', 'sending') ORDER BY c.id);

  -- G8 retail credit: the retail rank allows an overdraft; a retail account never buys on credit (client_groups_retail_no_credit_check).
  findings := findings || ARRAY(
    SELECT format('G8 client_groups %s', g.id)
      FROM client_groups g WHERE g.kind = 'b2c_retail' AND g.overdraft_allowed ORDER BY g.id);

  IF cardinality(findings) > 0 THEN
    RAISE EXCEPTION 'accounts merge stopped, nothing changed: % (% finding%)',
      array_to_string(findings[1:50], '; '), cardinality(findings), CASE WHEN cardinality(findings) = 1 THEN '' ELSE 's' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'accounts_merge_preflight';
  END IF;
END
$$;
