-- Feature 14b (customer account mails): the four customer mails (sign-in link, password reset, invitation, email verification) are sent
-- through the notification delivery path (decision 033), so each needs a default English template; a missing template sends nothing.
-- Staff edit them in the console afterwards; a row that exists (same event, channel, audience and language) is left as it is.
-- Generated from DEFAULT_TEMPLATES (src/modules/platform/notifications/default-templates.ts); a test keeps the two equal.
INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES
  ('customer.magic_link', 'email', 'customer', 'en', 'Your sign-in link', 'Hi {{customerName}},

Use this link to sign in to your GSM account:

{{link}}

The link works once and stops working at {{expiresAt}}. If you did not ask for it, you can ignore this email.', true),
  ('customer.password_reset', 'email', 'customer', 'en', 'Reset your password', 'Hi {{customerName}},

Use this link to choose a new password:

{{link}}

The link works once and stops working at {{expiresAt}}. If you did not ask for a new password, you can ignore this email: your password stays as it is.', true),
  ('customer.invited', 'email', 'customer', 'en', 'Your GSM account is ready', 'Hi {{customerName}},

Our team created a GSM account for you. Choose your password here to sign in:

{{link}}

The link works once and stops working at {{expiresAt}}.', true),
  ('customer.email_verification', 'email', 'customer', 'en', 'Confirm your email address', 'Hi {{customerName}},

The email address of your GSM account was changed to this one. Confirm it here:

{{link}}

The link works once and stops working at {{expiresAt}}. If this is not your account, you can ignore this email.', true)
ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;
