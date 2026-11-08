-- Feature 16 (storefront money): the customer mails the storefront flows send (decision 033) need their default English templates, because a
-- missing template sends nothing: `order.received`, `order.completed`, `order.failed` and `payment.failed` (the console's Customer emails tab)
-- and `refund.declined` (staff decline a refund request and the customer is told why).
-- Staff edit them in the console afterwards; a row that exists (same event, channel, audience and language) is left as it is.
-- Generated from DEFAULT_TEMPLATES (src/modules/platform/notifications/default-templates.ts); a test keeps the two equal.
INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES
  ('order.received', 'email', 'customer', 'en', 'Your order {{orderId}} is confirmed', 'Hi {{customerName}}, thanks for your order. We received {{amount}} for "{{service}}". We will email you the result as soon as the carrier confirms it, usually within a few hours.', true),
  ('order.completed', 'email', 'customer', 'en', 'Your unlock is ready', 'Hi {{customerName}}, good news: the carrier confirmed the unlock for {{orderId}}. Insert a SIM from another network and restart the phone. If anything is unclear, just reply to this email.', true),
  ('order.failed', 'email', 'customer', 'en', 'We couldn’t unlock order {{orderId}}', 'Hi {{customerName}}, the carrier rejected this unlock, so we have refunded {{amount}} to your card. It can take 5 to 10 days to appear. We are sorry it did not work out.', true),
  ('payment.failed', 'email', 'customer', 'en', 'Your payment didn’t go through', 'Hi {{customerName}}, the payment of {{amount}} for your unlock was declined by your bank, so we did not start it. Nothing was charged. You can try again or use another card.', true),
  ('refund.declined', 'email', 'customer', 'en', 'About your refund request for order {{orderId}}', 'Hi {{customerName}},

We looked at your refund request of {{amount}} for order {{orderId}} and we could not approve it.

Reason: {{reason}}

If you have more details that could change this, reply to this email and we will look again.', true)
ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;