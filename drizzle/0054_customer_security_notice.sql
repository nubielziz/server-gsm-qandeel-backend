-- Feature 37 (decision 047): the default template of the customer's security notice (`customer.security_notice`; customer audience,
-- email), sent to the address before a staff change of the account's email address. A row that exists is left as it is. Written by
-- `templatesInsertSql` from DEFAULT_TEMPLATES (src/modules/platform/notifications/default-templates.ts); a spec keeps the two equal.
INSERT INTO "notification_templates" ("event", "channel", "audience", "subject", "body", "is_active") VALUES
  ('customer.security_notice', 'email', 'customer', 'A security change on your account', 'Hi {{customerName}},

Our support team made this change to your account: {{change}}.

If you did not ask for it, reply to this email or contact our support team at once.', true)
ON CONFLICT ("event", "channel", "audience") DO NOTHING;
