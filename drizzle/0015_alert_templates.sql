-- Feature 12b (alerts): the default templates of the two alert messages (`alert.fired`, `alert.resolved`; staff audience, email and Telegram).
-- Without them a fired or resolved alert would send nothing (a missing template sends nothing). Staff edit them in the console afterwards; a row
-- that exists (same event, channel, audience and language) is left as it is.
-- Generated from DEFAULT_TEMPLATES (src/modules/platform/notifications/default-templates.ts, the staff rows); a test keeps the two equal.
INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES
  ('alert.fired', 'email', 'staff', 'en', 'Alert ({{severity}}): {{ruleName}} - {{subject}}', '{{ruleName}} fired on {{subject}} (severity: {{severity}}).

{{metric}} is {{value}} (limit {{threshold}}).
{{detail}}

Open System health, Alerts and incidents, in the admin console to acknowledge it.', true),
  ('alert.fired', 'telegram', 'staff', 'en', '', 'ALERT {{severity}}: {{ruleName}} on {{subject}}. {{metric}} is {{value}} (limit {{threshold}}). {{detail}}', true),
  ('alert.resolved', 'email', 'staff', 'en', 'Resolved: {{ruleName}} - {{subject}}', '{{ruleName}} on {{subject}} is resolved (severity was {{severity}}).

{{metric}} is {{value}} (limit {{threshold}}).
{{detail}}', true),
  ('alert.resolved', 'telegram', 'staff', 'en', '', 'RESOLVED: {{ruleName}} on {{subject}}. {{metric}} is {{value}} (limit {{threshold}}). {{detail}}', true)
ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;
