-- Feature 28 (support as a live chat): the merchant's reply mail and Telegram message link to the new portal ticket page.
-- The line "Open the conversation: {{link}}" (Arabic: "افتح المحادثة: {{link}}") is appended to the merchant's support.reply templates,
-- English (0016) and Arabic (0027), only where the body still equals the shipped default: a template staff edited keeps their text.
-- Generated from supportReplyLinkSql() (src/modules/support/application/support-templates.ts); a test keeps the two equal.
UPDATE "notification_templates" SET "body" = 'Hi {{merchantName}},

{{message}}

Ticket {{ticketNumber}}: {{subject}}
Open the conversation: {{link}}'
WHERE "event" = 'support.reply' AND "channel" = 'email' AND "audience" = 'merchant' AND "locale" = 'en' AND "body" = 'Hi {{merchantName}},

{{message}}

Ticket {{ticketNumber}}: {{subject}}';--> statement-breakpoint
UPDATE "notification_templates" SET "body" = 'Support replied on {{ticketNumber}} ({{subject}}):
{{message}}

Open the conversation: {{link}}'
WHERE "event" = 'support.reply' AND "channel" = 'telegram' AND "audience" = 'merchant' AND "locale" = 'en' AND "body" = 'Support replied on {{ticketNumber}} ({{subject}}):
{{message}}';--> statement-breakpoint
UPDATE "notification_templates" SET "body" = 'مرحباً {{merchantName}}،

{{message}}

التذكرة {{ticketNumber}}: {{subject}}
افتح المحادثة: {{link}}'
WHERE "event" = 'support.reply' AND "channel" = 'email' AND "audience" = 'merchant' AND "locale" = 'ar' AND "body" = 'مرحباً {{merchantName}}،

{{message}}

التذكرة {{ticketNumber}}: {{subject}}';--> statement-breakpoint
UPDATE "notification_templates" SET "body" = 'رد الدعم على {{ticketNumber}} ({{subject}}):
{{message}}

افتح المحادثة: {{link}}'
WHERE "event" = 'support.reply' AND "channel" = 'telegram' AND "audience" = 'merchant' AND "locale" = 'ar' AND "body" = 'رد الدعم على {{ticketNumber}} ({{subject}}):
{{message}}';
