-- Feature 23: the Arabic default templates of the merchant and customer events (written by arabicTemplatesSql(); a spec keeps them equal).
INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES
  ('merchant.email_verification', 'email', 'merchant', 'ar', 'أكّد بريدك الإلكتروني', 'مرحباً {{merchantName}}،

يُرجى تأكيد بريدك الإلكتروني لإكمال إنشاء حسابك في GSM:

{{link}}

يعمل الرابط مرة واحدة فقط وينتهي في {{expiresAt}}. إذا لم تنشئ حساباً، يمكنك تجاهل هذه الرسالة.', true),
  ('merchant.password_reset', 'email', 'merchant', 'ar', 'إعادة تعيين كلمة المرور', 'مرحباً {{merchantName}}،

استخدم هذا الرابط لاختيار كلمة مرور جديدة:

{{link}}

يعمل الرابط مرة واحدة فقط وينتهي في {{expiresAt}}. إذا لم تطلب كلمة مرور جديدة، يمكنك تجاهل هذه الرسالة: تبقى كلمة مرورك كما هي.', true),
  ('merchant.invited', 'email', 'merchant', 'ar', 'حسابك كتاجر في GSM جاهز', 'مرحباً {{merchantName}}،

أنشأ فريقنا حساب تاجر في GSM لك. اختر كلمة مرورك من هنا لتسجيل الدخول:

{{link}}

يعمل الرابط مرة واحدة فقط وينتهي في {{expiresAt}}.', true),
  ('wallet.low_balance', 'email', 'merchant', 'ar', 'رصيد محفظتك منخفض', 'مرحباً {{merchantName}}،

رصيدك المتاح {{available}} {{currency}}، وهو أقل من حد التنبيه {{threshold}} {{currency}}. اشحن محفظتك ليستمر تنفيذ طلباتك.', true),
  ('wallet.low_balance', 'telegram', 'merchant', 'ar', '', 'رصيد منخفض: المتاح {{available}} {{currency}} (حد التنبيه {{threshold}} {{currency}}).', true),
  ('service.price_changed', 'email', 'merchant', 'ar', 'تغيّرت أسعار خدمات طلبتها', 'مرحباً {{merchantName}}،

تغيّر سعر {{count}} خدمة طلبتها خلال آخر 30 يوماً:

{{changes}}

يعرض الكتالوج وقائمة الأسعار لديك الأسعار الجديدة.', true),
  ('service.price_changed', 'telegram', 'merchant', 'ar', '', 'تغيّرت أسعار خدمات طلبتها ({{count}}):
{{changes}}', true),
  ('deposit.approved', 'email', 'merchant', 'ar', 'تمت الموافقة على إيداعك بقيمة {{amount}} {{currency}}', 'مرحباً {{merchantName}}،

تمت الموافقة على إيداعك بقيمة {{amount}} {{currency}} وأُضيف المبلغ إلى محفظتك.', true),
  ('deposit.approved', 'telegram', 'merchant', 'ar', '', 'تمت الموافقة على الإيداع: أُضيف {{amount}} {{currency}} إلى محفظتك.', true),
  ('invoice.paid', 'email', 'merchant', 'ar', 'تم دفع الفاتورة {{invoiceNumber}}', 'مرحباً {{merchantName}}،

تم دفع الفاتورة {{invoiceNumber}} ({{amount}} {{currency}}) وأُضيف المبلغ إلى محفظتك.', true),
  ('invoice.paid', 'telegram', 'merchant', 'ar', '', 'تم دفع الفاتورة {{invoiceNumber}}: أُضيف {{amount}} {{currency}} إلى محفظتك.', true),
  ('order.completed', 'email', 'merchant', 'ar', 'تم تنفيذ الطلب {{orderId}}', 'مرحباً {{merchantName}}،

تم تنفيذ الطلب {{orderId}} ({{service}}). {{resultComment}}

النتيجة متاحة في لوحتك.', true),
  ('order.completed', 'telegram', 'merchant', 'ar', '', 'تم تنفيذ الطلب {{orderId}}. النتيجة متاحة في لوحتك.', true),
  ('order.failed', 'email', 'merchant', 'ar', 'تم رفض الطلب {{orderId}}', 'مرحباً {{merchantName}}،

تم رفض الطلب {{orderId}} ({{service}}). {{resultComment}}

عاد المبلغ إلى محفظتك.', true),
  ('order.failed', 'telegram', 'merchant', 'ar', '', 'تم رفض الطلب {{orderId}}. {{resultComment}}', true),
  ('telegram.linked', 'telegram', 'merchant', 'ar', '', 'تم الربط مع {{merchantName}}.', true),
  ('telegram.unlinked', 'telegram', 'merchant', 'ar', '', 'تم إيقاف إشعارات Telegram لـ {{merchantName}}. أنشئ رابطاً جديداً من البوابة لربط هذه المحادثة مرة أخرى.', true),
  ('customer.magic_link', 'email', 'customer', 'ar', 'رابط تسجيل الدخول', 'مرحباً {{customerName}}،

استخدم هذا الرابط لتسجيل الدخول إلى حسابك في GSM:

{{link}}

يعمل الرابط مرة واحدة فقط وينتهي في {{expiresAt}}. إذا لم تطلبه، يمكنك تجاهل هذه الرسالة.', true),
  ('customer.password_reset', 'email', 'customer', 'ar', 'إعادة تعيين كلمة المرور', 'مرحباً {{customerName}}،

استخدم هذا الرابط لاختيار كلمة مرور جديدة:

{{link}}

يعمل الرابط مرة واحدة فقط وينتهي في {{expiresAt}}. إذا لم تطلب كلمة مرور جديدة، يمكنك تجاهل هذه الرسالة: تبقى كلمة مرورك كما هي.', true),
  ('customer.invited', 'email', 'customer', 'ar', 'حسابك في GSM جاهز', 'مرحباً {{customerName}}،

أنشأ فريقنا حساباً في GSM لك. اختر كلمة مرورك من هنا لتسجيل الدخول:

{{link}}

يعمل الرابط مرة واحدة فقط وينتهي في {{expiresAt}}.', true),
  ('customer.email_verification', 'email', 'customer', 'ar', 'أكّد بريدك الإلكتروني', 'مرحباً {{customerName}}،

تم تغيير البريد الإلكتروني لحسابك في GSM إلى هذا العنوان. أكّده من هنا:

{{link}}

يعمل الرابط مرة واحدة فقط وينتهي في {{expiresAt}}. إذا لم يكن هذا حسابك، يمكنك تجاهل هذه الرسالة.', true),
  ('order.received', 'email', 'customer', 'ar', 'تم تأكيد طلبك {{orderId}}', 'مرحباً {{customerName}}، شكراً لطلبك. استلمنا {{amount}} مقابل "{{service}}". سنراسلك بالنتيجة فور تأكيد شركة الاتصالات، وعادةً خلال ساعات قليلة.', true),
  ('order.completed', 'email', 'customer', 'ar', 'فتح القفل جاهز', 'مرحباً {{customerName}}، أخبار سارة: أكدت شركة الاتصالات فتح القفل للطلب {{orderId}}. ضع شريحة من شبكة أخرى وأعد تشغيل الهاتف. إذا كان أي شيء غير واضح، ردّ على هذه الرسالة.', true),
  ('order.failed', 'email', 'customer', 'ar', 'تعذّر فتح القفل للطلب {{orderId}}', 'مرحباً {{customerName}}، رفضت شركة الاتصالات طلب فتح القفل هذا، لذلك أعدنا {{amount}} إلى بطاقتك. قد يستغرق ظهور المبلغ من 5 إلى 10 أيام. نأسف لأن الطلب لم يتم.', true),
  ('payment.failed', 'email', 'customer', 'ar', 'لم تتم عملية الدفع', 'مرحباً {{customerName}}، رفض مصرفك دفعة {{amount}} لطلب فتح القفل، لذلك لم نبدأ الطلب. لم يتم خصم أي مبلغ. يمكنك المحاولة مرة أخرى أو استخدام بطاقة أخرى.', true),
  ('refund.declined', 'email', 'customer', 'ar', 'بخصوص طلب الاسترداد للطلب {{orderId}}', 'مرحباً {{customerName}}،

راجعنا طلب الاسترداد بقيمة {{amount}} للطلب {{orderId}} ولم نتمكن من الموافقة عليه.

السبب: {{reason}}

إذا كانت لديك تفاصيل إضافية قد تغيّر القرار، ردّ على هذه الرسالة وسننظر في الأمر مجدداً.', true),
  ('support.reply', 'email', 'customer', 'ar', 'رد: {{subject}} ({{ticketNumber}})', 'مرحباً {{customerName}}،

{{message}}

التذكرة {{ticketNumber}}: {{subject}}
اقرأ المحادثة كاملة أو ردّ من هنا: {{link}}', true),
  ('support.ticket_received', 'email', 'customer', 'ar', 'استلمنا رسالتك ({{ticketNumber}})', 'مرحباً {{customerName}}،

استلمنا رسالتك "{{subject}}" وفتحنا التذكرة {{ticketNumber}}. سيرد فريقنا عبر البريد الإلكتروني.

يمكنك متابعة التذكرة وإضافة تفاصيل من هنا: {{link}}

يُرجى الاحتفاظ بهذه الرسالة: الرابط خاص بك.', true),
  ('support.csat_survey', 'email', 'customer', 'ar', 'كيف كانت تجربتك؟ ({{ticketNumber}})', 'مرحباً {{customerName}}،

حددنا تذكرتك {{ticketNumber}} "{{subject}}" كمحلولة. أخبرنا كيف كانت خدمتنا، يستغرق ذلك خمس ثوانٍ فقط:

{{link}}

إذا لم تُحل مشكلتك، اكتب في الصفحة نفسها وسنعيد فتح التذكرة.', true),
  ('support.reply', 'email', 'merchant', 'ar', 'رد: {{subject}} ({{ticketNumber}})', 'مرحباً {{merchantName}}،

{{message}}

التذكرة {{ticketNumber}}: {{subject}}', true),
  ('support.reply', 'telegram', 'merchant', 'ar', '', 'رد الدعم على {{ticketNumber}} ({{subject}}):
{{message}}', true)
ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;
