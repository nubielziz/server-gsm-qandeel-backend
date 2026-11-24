-- The realistic data of the expand migration of one account type (backend decision 064), at the schema before it: two merchants with
-- wallets (one still pending), a merchant whose email a guest customer typed, a merchant and a customer with a login that share an email,
-- a blocked customer, an anonymized one, a customer with its own email and a store balance, orders of both doors, top-ups of both kinds,
-- a refund of an order to the store balance, an orderless return of a held payment, a dispute of a card top-up, sessions, open links,
-- notifications (one in-app item without an occurrence key, one campaign item that both rows of the pair received), a campaign that
-- lists people by hand, tickets with a message and an attachment, consents (an old unsubscribe among them), a blocklist entry, a risk
-- assessment, a data request, audit rows, order events and journals with the old words.
--
-- Used by test/integration/infra/accounts-expand-{migration,stops}.test.ts and by the development dry run of the release (loaded into a
-- copy of the development database: no row has a fixed id, every row is found again by its "amfx" name, email or key). The last block
-- is the approval of the pair: the file with it is the approved variant, without it (the lines between its two markers left out) the
-- variant the migration must stop on (E5). Every amount is in USD; every journal balances and every balance equals its entries.

CREATE FUNCTION pg_temp.amfx_account(p_kind text, p_owner_type text, p_owner_id bigint) RETURNS bigint LANGUAGE plpgsql AS $fn$
DECLARE
  found bigint;
BEGIN
  INSERT INTO ledger_accounts (kind, owner_type, owner_id, currency) VALUES (p_kind, p_owner_type, p_owner_id, 'USD')
  ON CONFLICT DO NOTHING;
  SELECT id INTO found FROM ledger_accounts
   WHERE kind = p_kind AND owner_type IS NOT DISTINCT FROM p_owner_type AND owner_id IS NOT DISTINCT FROM p_owner_id AND currency = 'USD';
  RETURN found;
END
$fn$;

-- One journal: lines are [{"account": id, "amount": debit-positive}], balances kept in each account's normal sign.
CREATE FUNCTION pg_temp.amfx_post(p_kind text, p_ref_type text, p_ref_id bigint, p_key text, p_by_type text, p_by_id bigint, p_lines jsonb)
RETURNS bigint LANGUAGE plpgsql AS $fn$
DECLARE
  tx bigint;
  line jsonb;
  after numeric;
BEGIN
  INSERT INTO ledger_transactions (kind, ref_type, ref_id, memo, idempotency_key, created_by_type, created_by_id)
  VALUES (p_kind, p_ref_type, p_ref_id, 'amfx fixture', p_key, p_by_type, p_by_id) RETURNING id INTO tx;
  FOR line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    UPDATE ledger_accounts
       SET balance = balance + CASE WHEN kind IN ('revenue', 'client_wallet', 'client_hold', 'customer_wallet')
                                    THEN -(line ->> 'amount')::numeric ELSE (line ->> 'amount')::numeric END,
           version = version + 1, updated_at = now()
     WHERE id = (line ->> 'account')::bigint
    RETURNING balance INTO after;
    INSERT INTO ledger_entries (transaction_id, account_id, amount, balance_after)
    VALUES (tx, (line ->> 'account')::bigint, (line ->> 'amount')::numeric, after);
  END LOOP;
  RETURN tx;
END
$fn$;

DO $fixture$
DECLARE
  staff bigint; merchants bigint; category bigint; service bigint; card bigint; bank_gateway bigint;
  ma bigint; mb bigint; mc bigint;
  cb bigint; ca bigint; cg bigint; cp bigint; co bigint;
  bank bigint; clearing bigint; revenue bigint; adjustments bigint;
  ma_wallet bigint; ma_hold bigint; mc_wallet bigint; cp_wallet bigint; co_wallet bigint;
  ma_order bigint; cp_order bigint; co_order bigint; cg_order bigint;
  cp_session bigint; co_session bigint; co_held_session bigint; cg_session bigint;
  mc_topup bigint; cp_topup bigint; co_topup bigint;
  mc_topup_payment bigint; cp_topup_payment bigint; co_topup_payment bigint;
  cp_order_payment bigint; co_order_payment bigint; co_held_payment bigint; cg_order_payment bigint;
  refund_tx bigint; co_refund bigint;
  campaign bigint; cp_ticket bigint; ma_ticket bigint; cp_file bigint; ma_file bigint;
BEGIN
  INSERT INTO currencies (code, name) VALUES ('USD', 'US dollar') ON CONFLICT DO NOTHING;
  INSERT INTO roles (name, permissions) VALUES ('AMFX owner', '{*}') RETURNING id INTO staff;
  INSERT INTO staff_users (email, name, role_id, status) VALUES ('amfx-staff@example.test', 'AMFX staff', staff, 'active')
  RETURNING id INTO staff;
  INSERT INTO client_groups (name, kind) VALUES ('AMFX merchants', 'b2b') RETURNING id INTO merchants;
  INSERT INTO service_categories (name, type) VALUES ('AMFX unlocks', 'imei') RETURNING id INTO category;
  INSERT INTO services (category_id, type, name, fulfillment, base_price, code, sla_minutes)
  VALUES (category, 'imei', 'AMFX check', 'manual', 10, 'AMFX-CHECK', 60) RETURNING id INTO service;
  INSERT INTO payment_gateways (code, driver, name) VALUES ('amfx-card', 'stripe', 'AMFX card') RETURNING id INTO card;
  INSERT INTO payment_gateways (code, driver, name, is_manual) VALUES ('amfx-bank', 'manual', 'AMFX bank', true)
  RETURNING id INTO bank_gateway;

  -- Merchants: an active one (its email is also typed by a guest customer), a pending one, and the merchant of the pair.
  INSERT INTO clients (username, email, name, group_id, referral_code, status, country, internal_notes)
  VALUES ('amfx-ma', 'amfx-ma@example.test', 'AMFX Merchant A', merchants, 'AMFX-MA', 'active', 'JO', '') RETURNING id INTO ma;
  INSERT INTO clients (username, email, name, group_id, referral_code, status)
  VALUES ('amfx-mb', 'amfx-mb@example.test', 'AMFX Merchant B', merchants, 'AMFX-MB', 'pending') RETURNING id INTO mb;
  INSERT INTO clients (username, email, name, group_id, referral_code, status, phone, internal_notes, email_verified_at, last_login_at)
  VALUES ('amfx-mc', 'Amfx-Pair@example.test', 'AMFX Merchant C', merchants, 'AMFX-MC', 'active', '', 'merchant note', NULL,
          '2026-03-01T10:00:00Z') RETURNING id INTO mc;

  -- Customers: blocked, anonymized, a guest with a merchant's email (and a stray credentials row), the customer of the pair, and one
  -- with its own email.
  INSERT INTO customers (email, name, has_account, status) VALUES ('amfx-cb@example.test', 'AMFX Blocked', true, 'blocked')
  RETURNING id INTO cb;
  INSERT INTO customers (email, name, has_account, status, anonymized_at)
  VALUES ('deleted-amfx@redacted.invalid', '', false, 'anonymized', '2026-02-01T00:00:00Z') RETURNING id INTO ca;
  INSERT INTO customers (email, name, has_account, status) VALUES ('AMFX-MA@example.test', 'AMFX Guest', false, 'active')
  RETURNING id INTO cg;
  INSERT INTO customers (email, name, phone, country, has_account, status, email_verified_at, last_login_at, internal_notes,
                         marketing_opt_in, currency, created_by)
  VALUES ('amfx-pair@example.test', 'AMFX Pair Customer', '+962700000001', 'JO', true, 'active', '2026-01-05T00:00:00Z',
          '2026-04-01T10:00:00Z', 'customer note', true, 'USD', staff) RETURNING id INTO cp;
  INSERT INTO customers (email, name, country, has_account, status, email_verified_at)
  VALUES ('amfx-own@example.test', 'AMFX Own', 'GB', true, 'active', '2026-01-06T00:00:00Z') RETURNING id INTO co;
  INSERT INTO customer_credentials (customer_id, password_hash, updated_by) VALUES (cb, 'argon2-amfx-cb', NULL);
  INSERT INTO customer_credentials (customer_id, password_hash, updated_by) VALUES (cg, 'argon2-amfx-stray', NULL);
  INSERT INTO customer_credentials (customer_id, password_hash, updated_by) VALUES (cp, 'argon2-amfx-cp', NULL);
  INSERT INTO customer_credentials (customer_id, password_hash, must_change_password, password_changed_at, updated_by)
  VALUES (co, 'argon2-amfx-co', true, '2026-01-07T00:00:00Z', staff);

  -- Ledger accounts: the shared system accounts (found or made), both wallets of each merchant, and two store wallets.
  bank := pg_temp.amfx_account('bank', NULL, NULL);
  clearing := pg_temp.amfx_account('gateway_clearing', NULL, NULL);
  revenue := pg_temp.amfx_account('revenue', NULL, NULL);
  adjustments := pg_temp.amfx_account('adjustments', NULL, NULL);
  ma_wallet := pg_temp.amfx_account('client_wallet', 'client', ma);
  ma_hold := pg_temp.amfx_account('client_hold', 'client', ma);
  PERFORM pg_temp.amfx_account('client_wallet', 'client', mb);
  PERFORM pg_temp.amfx_account('client_hold', 'client', mb);
  mc_wallet := pg_temp.amfx_account('client_wallet', 'client', mc);
  PERFORM pg_temp.amfx_account('client_hold', 'client', mc);
  cp_wallet := pg_temp.amfx_account('customer_wallet', 'customer', cp);
  co_wallet := pg_temp.amfx_account('customer_wallet', 'customer', co);

  -- Merchant A: a deposit by staff, a manual invoice, a completed portal order (hold, then settle).
  PERFORM pg_temp.amfx_post('deposit', 'client', ma, 'amfx:deposit:ma', 'staff', staff,
    jsonb_build_array(jsonb_build_object('account', bank, 'amount', 100), jsonb_build_object('account', ma_wallet, 'amount', -100)));
  INSERT INTO invoices (number, client_id, kind, amount, net_amount, total, currency, status)
  VALUES ('AMFX-INV-MA', ma, 'manual', 25, 25, 25, 'USD', 'paid');
  INSERT INTO orders (service_id, type, source, client_id, unit_price, total_price, currency, status, dispatch_state)
  VALUES (service, 'imei', 'portal', ma, 10, 10, 'USD', 'completed', 'done') RETURNING id INTO ma_order;
  PERFORM pg_temp.amfx_post('order_hold', 'order', ma_order, 'amfx:hold:ma', 'client', ma,
    jsonb_build_array(jsonb_build_object('account', ma_wallet, 'amount', 10), jsonb_build_object('account', ma_hold, 'amount', -10)));
  PERFORM pg_temp.amfx_post('order_settle', 'order', ma_order, 'amfx:settle:ma', 'system', NULL,
    jsonb_build_array(jsonb_build_object('account', ma_hold, 'amount', 10), jsonb_build_object('account', revenue, 'amount', -10)));
  INSERT INTO order_events (order_id, type, to_status, actor_type, actor_id) VALUES (ma_order, 'created', 'pending', 'client', ma);
  INSERT INTO order_events (order_id, type, from_status, to_status, actor_type) VALUES (ma_order, 'completed', 'processing', 'completed', 'system');
  INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id) VALUES ('client', ma, 'merchant.update', 'merchant', ma);

  -- Merchant C (the pair): a paid merchant top-up by bank transfer.
  INSERT INTO invoices (number, client_id, kind, amount, net_amount, total, currency, status, idempotency_key)
  VALUES ('AMFX-INV-MC', mc, 'topup', 40, 40, 40, 'USD', 'paid', 'amfx-key-mc') RETURNING id INTO mc_topup;
  INSERT INTO payments (invoice_id, purpose, gateway_id, amount, currency, status, method_type)
  VALUES (mc_topup, 'topup', bank_gateway, 40, 'USD', 'approved', 'bank') RETURNING id INTO mc_topup_payment;
  PERFORM pg_temp.amfx_post('deposit', 'payment', mc_topup_payment, 'amfx:topup:mc', 'staff', staff,
    jsonb_build_array(jsonb_build_object('account', bank, 'amount', 40), jsonb_build_object('account', mc_wallet, 'amount', -40)));

  -- The customer of the pair: a store top-up by card, spent to zero on a balance-paid shop order (a wallet with history at zero).
  INSERT INTO invoices (number, customer_id, kind, amount, net_amount, total, currency, status, idempotency_key)
  VALUES ('AMFX-INV-CP', cp, 'topup', 10, 10, 10, 'USD', 'paid', 'amfx-key-cp') RETURNING id INTO cp_topup;
  INSERT INTO payments (invoice_id, customer_id, purpose, gateway_id, amount, currency, status, method_type)
  VALUES (cp_topup, cp, 'topup', card, 10, 'USD', 'approved', 'card') RETURNING id INTO cp_topup_payment;
  PERFORM pg_temp.amfx_post('deposit', 'payment', cp_topup_payment, 'amfx:topup:cp', 'customer', cp,
    jsonb_build_array(jsonb_build_object('account', clearing, 'amount', 10), jsonb_build_object('account', cp_wallet, 'amount', -10)));
  INSERT INTO checkout_sessions (token, customer_id, email, service_id, currency, net_amount, gross_amount, expires_at, status)
  VALUES ('amfx-cs-cp', cp, 'amfx-pair@example.test', service, 'USD', 10, 10, now() + interval '1 day', 'paid') RETURNING id INTO cp_session;
  INSERT INTO orders (service_id, type, source, customer_id, unit_price, total_price, currency, status, dispatch_state, checkout_session_id)
  VALUES (service, 'imei', 'store', cp, 10, 10, 'USD', 'completed', 'done', cp_session) RETURNING id INTO cp_order;
  UPDATE checkout_sessions SET order_id = cp_order WHERE id = cp_session;
  INSERT INTO payments (customer_id, order_id, checkout_session_id, purpose, amount, currency, status, method_type)
  VALUES (cp, cp_order, cp_session, 'order', 10, 'USD', 'captured', 'balance') RETURNING id INTO cp_order_payment;
  PERFORM pg_temp.amfx_post('b2c_payment', 'order', cp_order, 'amfx:pay:cp', 'customer', cp,
    jsonb_build_array(jsonb_build_object('account', cp_wallet, 'amount', 10), jsonb_build_object('account', revenue, 'amount', -10)));
  INSERT INTO order_events (order_id, type, to_status, actor_type, actor_id) VALUES (cp_order, 'created', 'pending', 'customer', cp);

  -- The customer with its own email: a card top-up (disputed), a balance-paid order refunded in part to the store balance, a staff
  -- adjustment of the store balance with the old reference word, a held card payment returned without an order.
  INSERT INTO invoices (number, customer_id, kind, amount, net_amount, total, currency, status)
  VALUES ('AMFX-INV-CO', co, 'topup', 50, 50, 50, 'USD', 'paid') RETURNING id INTO co_topup;
  INSERT INTO payments (invoice_id, customer_id, purpose, gateway_id, amount, currency, status, method_type, gateway_txn_id)
  VALUES (co_topup, co, 'topup', card, 50, 'USD', 'approved', 'card', 'amfx-txn-co-topup') RETURNING id INTO co_topup_payment;
  PERFORM pg_temp.amfx_post('deposit', 'payment', co_topup_payment, 'amfx:topup:co', 'customer', co,
    jsonb_build_array(jsonb_build_object('account', clearing, 'amount', 50), jsonb_build_object('account', co_wallet, 'amount', -50)));
  INSERT INTO disputes (payment_id, customer_id, gateway_dispute_id, reason_code, amount, currency, status, evidence_due_at)
  VALUES (co_topup_payment, co, 'amfx-dp-1', 'fraudulent', 50, 'USD', 'under_review', now() + interval '7 days');
  INSERT INTO invoices (number, customer_id, kind, amount, net_amount, total, currency, status)
  VALUES ('AMFX-RCT-CO', co, 'receipt', 20, 20, 20, 'USD', 'paid');
  INSERT INTO checkout_sessions (token, customer_id, email, service_id, currency, net_amount, gross_amount, expires_at, status)
  VALUES ('amfx-cs-co', co, 'amfx-own@example.test', service, 'USD', 20, 20, now() + interval '1 day', 'paid') RETURNING id INTO co_session;
  INSERT INTO orders (service_id, type, source, customer_id, unit_price, total_price, currency, status, dispatch_state, checkout_session_id)
  VALUES (service, 'imei', 'store', co, 20, 20, 'USD', 'completed', 'done', co_session) RETURNING id INTO co_order;
  UPDATE checkout_sessions SET order_id = co_order WHERE id = co_session;
  INSERT INTO payments (customer_id, order_id, checkout_session_id, purpose, amount, currency, status, method_type)
  VALUES (co, co_order, co_session, 'order', 20, 'USD', 'partial_refund', 'balance') RETURNING id INTO co_order_payment;
  PERFORM pg_temp.amfx_post('b2c_payment', 'order', co_order, 'amfx:pay:co', 'customer', co,
    jsonb_build_array(jsonb_build_object('account', co_wallet, 'amount', 20), jsonb_build_object('account', revenue, 'amount', -20)));
  INSERT INTO order_events (order_id, type, to_status, actor_type, actor_id) VALUES (co_order, 'created', 'pending', 'customer', co);
  INSERT INTO refunds (payment_id, order_id, customer_id, amount, currency, method, status, requested_by_type, requested_by_id, completed_at)
  VALUES (co_order_payment, co_order, co, 5, 'USD', 'original', 'completed', 'customer', co, now()) RETURNING id INTO co_refund;
  refund_tx := pg_temp.amfx_post('refund', 'refund', co_refund, 'amfx:refund:co', 'staff', staff,
    jsonb_build_array(jsonb_build_object('account', revenue, 'amount', 5), jsonb_build_object('account', co_wallet, 'amount', -5)));
  UPDATE refunds SET ledger_tx_id = refund_tx WHERE id = co_refund;
  PERFORM pg_temp.amfx_post('adjustment', 'customer', co, 'amfx:adjust:co', 'staff', staff,
    jsonb_build_array(jsonb_build_object('account', adjustments, 'amount', 1), jsonb_build_object('account', co_wallet, 'amount', -1)));
  INSERT INTO checkout_sessions (token, customer_id, email, service_id, currency, net_amount, gross_amount, expires_at, status)
  VALUES ('amfx-cs-held', co, 'amfx-own@example.test', service, 'USD', 15, 15, now() - interval '1 day', 'expired')
  RETURNING id INTO co_held_session;
  INSERT INTO payments (customer_id, checkout_session_id, purpose, gateway_id, amount, currency, status, method_type, gateway_txn_id)
  VALUES (co, co_held_session, 'order', card, 15, 'USD', 'refunded', 'card', 'amfx-txn-co-held') RETURNING id INTO co_held_payment;
  INSERT INTO refunds (payment_id, amount, currency, method, status, requested_by_type, requested_by_id, completed_at)
  VALUES (co_held_payment, 15, 'USD', 'original', 'completed', 'staff', staff, now());
  INSERT INTO risk_assessments (checkout_session_id, order_id, customer_id, score, decision, provider)
  VALUES (co_session, co_order, co, 12, 'allow', 'internal');
  INSERT INTO data_requests (customer_id, kind, status, due_at, completed_at)
  VALUES (co, 'export', 'completed', now() + interval '30 days', now());
  INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id) VALUES ('customer', co, 'customer.update', 'customer', co);

  -- The guest: a paid card order through a checkout typed with merchant A's email, and its consents.
  INSERT INTO checkout_sessions (token, customer_id, email, service_id, currency, net_amount, gross_amount, expires_at, status)
  VALUES ('amfx-cs-cg', cg, 'AMFX-MA@example.test', service, 'USD', 10, 10, now() + interval '1 day', 'paid') RETURNING id INTO cg_session;
  INSERT INTO orders (service_id, type, source, customer_id, unit_price, total_price, currency, status, dispatch_state, checkout_session_id)
  VALUES (service, 'imei', 'store', cg, 10, 10, 'USD', 'processing', 'manual', cg_session) RETURNING id INTO cg_order;
  UPDATE checkout_sessions SET order_id = cg_order WHERE id = cg_session;
  INSERT INTO payments (customer_id, order_id, checkout_session_id, purpose, gateway_id, amount, currency, status, method_type, gateway_txn_id)
  VALUES (cg, cg_order, cg_session, 'order', card, 10, 'USD', 'captured', 'card', 'amfx-txn-cg') RETURNING id INTO cg_order_payment;
  INSERT INTO consent_records (subject_type, subject_id, purpose, granted, checkout_session_id, order_id, ip, user_agent)
  VALUES ('customer', cg, 'terms', true, cg_session, cg_order, '203.0.113.7', 'AMFX browser');

  -- The blocked customer: a blocklist entry.
  INSERT INTO blocklist_entries (kind, value_hash, display, reason, source, customer_id, created_by)
  VALUES ('email', 'amfx-hash-cb', 'a***@example.test', 'chargebacks', 'manual', cb, staff);

  -- Sessions of every kind, and open links: an invitation of the active merchant (stays usable), a reset of the pending merchant, a link
  -- and a verification of two customers.
  INSERT INTO sessions (token_hash, subject_type, subject_id, stage, ip, expires_at) VALUES
    ('amfx-session-staff', 'staff', staff, 'active', '203.0.113.1', now() + interval '1 day'),
    ('amfx-session-ma', 'client', ma, 'active', '203.0.113.2', now() + interval '1 day'),
    ('amfx-session-cp', 'customer', cp, 'active', '203.0.113.3', now() + interval '1 day'),
    ('amfx-session-co', 'customer', co, 'active', '203.0.113.4', now() + interval '1 day');
  INSERT INTO auth_tokens (purpose, subject_type, subject_id, token_hash, expires_at) VALUES
    ('invite', 'client', ma, 'amfx-token-ma', now() + interval '1 day'),
    ('reset', 'client', mb, 'amfx-token-mb', now() + interval '1 day'),
    ('magic_link', 'customer', co, 'amfx-token-co', now() + interval '1 hour'),
    ('verify_email', 'customer', cp, 'amfx-token-cp', now() + interval '1 day');

  -- Messages: one to the merchant, one to the customer of the pair; an in-app item of an event without an occurrence key; a campaign
  -- that both rows of the pair received (the customer read it first) and that lists people by hand.
  INSERT INTO notifications (recipient_type, recipient_id, channel, event, payload, status) VALUES
    ('client', ma, 'email', 'order.completed', '{"orderId": 1}', 'sent'),
    ('customer', cp, 'email', 'order.completed', '{"orderId": 2}', 'sent');
  INSERT INTO notification_inbox (recipient_type, recipient_id, event, category, variables)
  VALUES ('customer', cp, 'order.completed', 'order', '{}');
  INSERT INTO notification_campaigns (name, purpose, channels, audience, content, status, created_by, finished_at)
  VALUES ('AMFX campaign', 'service', '{in_app}',
          jsonb_build_object(
            'include', jsonb_build_array(jsonb_build_object('type', 'customer', 'id', cp), jsonb_build_object('type', 'client', 'id', mc),
                                         jsonb_build_object('type', 'customer', 'id', co), jsonb_build_object('type', 'staff', 'id', staff)),
            'exclude', jsonb_build_array(jsonb_build_object('type', 'customer', 'id', cb))),
          '{"en": {"title": "News", "body": "Body"}}', 'sent', staff, now())
  RETURNING id INTO campaign;
  INSERT INTO notification_inbox (recipient_type, recipient_id, campaign_id, category, read_at) VALUES
    ('customer', cp, campaign, 'announcement', '2026-05-01T08:00:00Z'),
    ('client', mc, campaign, 'announcement', NULL);

  -- Tickets: one of the customer of the pair with an attachment it owns, one of merchant A with a staff answer.
  INSERT INTO files (bucket, key, filename, mime, size, sha256, owner_type, owner_id)
  VALUES ('gsm-files', 'amfx/cp-receipt.png', 'receipt.png', 'image/png', 10, 'amfx-sha-cp', 'customer', cp) RETURNING id INTO cp_file;
  INSERT INTO files (bucket, key, filename, mime, size, sha256, owner_type, owner_id)
  VALUES ('gsm-files', 'amfx/ma-sheet.pdf', 'sheet.pdf', 'application/pdf', 20, 'amfx-sha-ma', 'client', ma) RETURNING id INTO ma_file;
  INSERT INTO support_tickets (number, subject, requester_type, requester_id, order_id)
  VALUES ('AMFX-T1', 'Where is my order', 'customer', cp, cp_order) RETURNING id INTO cp_ticket;
  INSERT INTO ticket_messages (ticket_id, author_type, author_id, body, file_ids)
  VALUES (cp_ticket, 'customer', cp, 'Here is my receipt', ARRAY[cp_file]);
  INSERT INTO support_tickets (number, subject, requester_type, requester_id) VALUES ('AMFX-T2', 'Price list', 'client', ma)
  RETURNING id INTO ma_ticket;
  INSERT INTO ticket_messages (ticket_id, author_type, author_id, body, file_ids) VALUES
    (ma_ticket, 'client', ma, 'Please see the sheet', ARRAY[ma_file]),
    (ma_ticket, 'staff', staff, 'Thank you', '{}');

  -- Consents of the customer with its own email (terms at checkout) and the old unsubscribe of the customer of the pair.
  INSERT INTO consent_records (subject_type, subject_id, purpose, granted, checkout_session_id, order_id, ip, user_agent)
  VALUES ('customer', co, 'terms', true, co_session, co_order, '203.0.113.4', 'AMFX browser');
  INSERT INTO consent_records (subject_type, subject_id, purpose, granted, ip) VALUES ('customer', cp, 'marketing', false, '203.0.113.3');
END
$fixture$;

-- accounts-merge:fixture:approved:begin
-- The owner approved the merchant and the customer that share "amfx-pair@example.test" as one account (the row the check script writes).
INSERT INTO settings (key, value)
SELECT 'accountsMerge.approvedPairs',
       jsonb_build_array(jsonb_build_object('clientId', m.id, 'customerId', c.id, 'action', 'one_account'))
  FROM clients m, customers c
 WHERE m.username = 'amfx-mc' AND c.email = 'amfx-pair@example.test';
-- accounts-merge:fixture:approved:end
