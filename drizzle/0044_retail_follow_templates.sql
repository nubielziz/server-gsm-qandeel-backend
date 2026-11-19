-- Feature 31 (decision 040, plan 31 sections 4 and 6.4): the default templates of the hourly message about following retail prices
-- (`retail.prices_followed`; staff audience, email and Telegram). Without them the message would send nothing (a missing template sends
-- nothing). Staff edit them in the console afterwards; a row that exists is left as it is. Written by `templatesInsertSql` from
-- DEFAULT_TEMPLATES (src/modules/platform/notifications/default-templates.ts); a spec keeps the two equal.
INSERT INTO "notification_templates" ("event", "channel", "audience", "subject", "body", "is_active") VALUES
  ('retail.prices_followed', 'email', 'staff', 'IMEI-HUB shop prices: {{changed}} changed, {{waiting}} waiting', 'The shop prices that follow your pricing rules moved since the last message.

Prices changed: {{changed}}
Changes waiting for your approval: {{waiting}}
Prices that stopped following a rule: {{detached}}

Review them on the Retail pricing tab:
{{link}}', true),
  ('retail.prices_followed', 'telegram', 'staff', '', 'IMEI-HUB shop prices: {{changed}} changed, {{waiting}} waiting for approval, {{detached}} stopped following a rule. {{link}}', true)
ON CONFLICT ("event", "channel", "audience") DO NOTHING;
