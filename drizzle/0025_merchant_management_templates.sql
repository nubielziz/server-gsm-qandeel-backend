-- Feature 20 (merchant management): the default templates of the identity events (merchant lifecycle mails in English and Arabic, staff link mails in English).
-- Staff edit them in the console afterwards; a row that exists (same event, channel, audience and language) is left as it is.
-- Generated from IDENTITY_DEFAULT_TEMPLATES (src/modules/identity/application/mail/identity-templates.ts); a test keeps the two equal.
INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES
  ('merchant.approved', 'email', 'merchant', 'en', 'Your merchant account is approved', 'Hi {{merchantName}},

Good news: our team approved your merchant account. You can now add funds, place orders and create API keys.

Sign in here: {{portalUrl}}

If you have not chosen a password yet, use "Forgot password" on the sign-in page.', true),
  ('merchant.approved', 'email', 'merchant', 'ar', 'تمت الموافقة على حساب التاجر الخاص بك', 'مرحباً {{merchantName}}،

وافق فريقنا على حساب التاجر الخاص بك. يمكنك الآن شحن الرصيد وتقديم الطلبات وإنشاء مفاتيح API.

سجّل الدخول من هنا: {{portalUrl}}

إذا لم تختر كلمة مرور بعد، استخدم «نسيت كلمة المرور» في صفحة تسجيل الدخول.', true),
  ('merchant.suspended', 'email', 'merchant', 'en', 'Your merchant account is suspended', 'Hi {{merchantName}},

Your merchant account has been suspended. You cannot sign in, and API calls are refused, until it is reactivated. Orders that are already in progress will still be completed.

If you think this is a mistake, reply to this email or contact our support team.', true),
  ('merchant.suspended', 'email', 'merchant', 'ar', 'تم إيقاف حساب التاجر الخاص بك', 'مرحباً {{merchantName}}،

تم إيقاف حساب التاجر الخاص بك. لا يمكنك تسجيل الدخول، وتُرفض طلبات الـ API، إلى أن يُعاد تفعيله. الطلبات الجارية ستُستكمل.

إذا كنت تعتقد أن هذا خطأ، ردّ على هذا البريد أو تواصل مع فريق الدعم.', true),
  ('merchant.reactivated', 'email', 'merchant', 'en', 'Your merchant account is active again', 'Hi {{merchantName}},

Your merchant account is active again. You can sign in and place orders: {{portalUrl}}

Your earlier sessions were ended, so please sign in again.', true),
  ('merchant.reactivated', 'email', 'merchant', 'ar', 'تمت إعادة تفعيل حساب التاجر الخاص بك', 'مرحباً {{merchantName}}،

أُعيد تفعيل حساب التاجر الخاص بك. يمكنك تسجيل الدخول وتقديم الطلبات: {{portalUrl}}

انتهت جلساتك السابقة، لذا يُرجى تسجيل الدخول من جديد.', true),
  ('merchant.kyc_approved', 'email', 'merchant', 'en', 'Your identity verification is approved', 'Hi {{merchantName}},

We reviewed your documents and your identity verification is approved. Thank you.', true),
  ('merchant.kyc_approved', 'email', 'merchant', 'ar', 'تمت الموافقة على توثيق هويتك', 'مرحباً {{merchantName}}،

راجعنا مستنداتك وتمت الموافقة على توثيق هويتك. شكراً لك.', true),
  ('merchant.kyc_rejected', 'email', 'merchant', 'en', 'Your identity verification needs attention', 'Hi {{merchantName}},

We could not approve your identity verification.

Reason: {{reason}}

You can upload new documents from the Verification page of your account.', true),
  ('merchant.kyc_rejected', 'email', 'merchant', 'ar', 'توثيق هويتك يحتاج إلى مراجعة', 'مرحباً {{merchantName}}،

لم نتمكن من الموافقة على توثيق هويتك.

السبب: {{reason}}

يمكنك رفع مستندات جديدة من صفحة التوثيق في حسابك.', true),
  ('merchant.security_notice', 'email', 'merchant', 'en', 'A security change on your merchant account', 'Hi {{merchantName}},

Our support team made this change to your account: {{change}}.

If you did not ask for it, reply to this email or contact our support team at once.', true),
  ('merchant.security_notice', 'email', 'merchant', 'ar', 'تغيير أمني في حساب التاجر الخاص بك', 'مرحباً {{merchantName}}،

أجرى فريق الدعم هذا التغيير على حسابك: {{change}}.

إذا لم تطلب ذلك، ردّ على هذا البريد أو تواصل مع فريق الدعم فوراً.', true),
  ('staff.invited', 'email', 'staff', 'en', 'You were invited to the GSM admin console', 'Hi {{staffName}},

You were added to the GSM admin console. Choose your password here:

{{link}}

The link works once, until {{expiresAt}}. After that, ask an owner to send a new one.', true),
  ('staff.password_reset', 'email', 'staff', 'en', 'Choose a new password for the GSM admin console', 'Hi {{staffName}},

An owner sent you a link to choose a new password:

{{link}}

The link works once, until {{expiresAt}}. Your current password keeps working until you use it. If you did not expect this email, tell an owner.', true)
ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;
