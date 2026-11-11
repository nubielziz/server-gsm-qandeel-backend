// The Arabic default templates of the merchant and customer events (feature 23, plan section 9.4, L2): one `ar` row for every English row of
// those two audiences, platform's (merchant mails, customer account and storefront mails) and support's. Migration 0021 inserts the same
// rows (a spec keeps code and SQL equal). Staff templates stay English. This file lives beside `default-templates.ts`, which it does not touch.
import type { NotificationAudience, NotificationChannel } from '../db/schema';

/** One Arabic default template, as the migration inserts it. */
export interface ArabicTemplate {
  readonly event: string;
  readonly channel: NotificationChannel;
  readonly audience: NotificationAudience;
  readonly locale: 'ar';
  readonly subject: string;
  readonly body: string;
}

const LINK_FOOTER = 'يعمل الرابط مرة واحدة فقط وينتهي في {{expiresAt}}.';
const IGNORE_PASSWORD = 'إذا لم تطلب كلمة مرور جديدة، يمكنك تجاهل هذه الرسالة: تبقى كلمة مرورك كما هي.';

const row = (
  event: string,
  channel: NotificationChannel,
  audience: NotificationAudience,
  subject: string,
  body: string,
): ArabicTemplate => ({ event, channel, audience, locale: 'ar', subject, body });

/**
 * The Arabic default templates: 31 rows, the Arabic twin of each English merchant or customer row of `DEFAULT_TEMPLATES` (26) and of the
 * support module's templates (5).
 *
 * Why: L2 and owner list E: an Arabic customer's order, payment, refund and ticket mails should arrive in Arabic; until now they fell back
 * to English. Modern Standard Arabic, short and polite, the same meaning and exactly the same `{{placeholders}}` as the English row, Latin
 * digits, product and service names untranslated, plain text (the delivery adds the right-to-left HTML part).
 */
export const ARABIC_DEFAULT_TEMPLATES: readonly ArabicTemplate[] = [
  row(
    'merchant.email_verification',
    'email',
    'merchant',
    'أكّد بريدك الإلكتروني',
    `مرحباً {{merchantName}}،\n\nيُرجى تأكيد بريدك الإلكتروني لإكمال إنشاء حسابك في GSM:\n\n{{link}}\n\n${LINK_FOOTER} إذا لم تنشئ حساباً، يمكنك تجاهل هذه الرسالة.`,
  ),
  row(
    'merchant.password_reset',
    'email',
    'merchant',
    'إعادة تعيين كلمة المرور',
    `مرحباً {{merchantName}}،\n\nاستخدم هذا الرابط لاختيار كلمة مرور جديدة:\n\n{{link}}\n\n${LINK_FOOTER} ${IGNORE_PASSWORD}`,
  ),
  row(
    'merchant.invited',
    'email',
    'merchant',
    'حسابك كتاجر في GSM جاهز',
    `مرحباً {{merchantName}}،\n\nأنشأ فريقنا حساب تاجر في GSM لك. اختر كلمة مرورك من هنا لتسجيل الدخول:\n\n{{link}}\n\n${LINK_FOOTER}`,
  ),
  row(
    'wallet.low_balance',
    'email',
    'merchant',
    'رصيد محفظتك منخفض',
    'مرحباً {{merchantName}}،\n\nرصيدك المتاح {{available}} {{currency}}، وهو أقل من حد التنبيه {{threshold}} {{currency}}. اشحن محفظتك ليستمر تنفيذ طلباتك.',
  ),
  row(
    'wallet.low_balance',
    'telegram',
    'merchant',
    '',
    'رصيد منخفض: المتاح {{available}} {{currency}} (حد التنبيه {{threshold}} {{currency}}).',
  ),
  row(
    'service.price_changed',
    'email',
    'merchant',
    'تغيّرت أسعار خدمات طلبتها',
    'مرحباً {{merchantName}}،\n\nتغيّر سعر {{count}} خدمة طلبتها خلال آخر 30 يوماً:\n\n{{changes}}\n\nيعرض الكتالوج وقائمة الأسعار لديك الأسعار الجديدة.',
  ),
  row('service.price_changed', 'telegram', 'merchant', '', 'تغيّرت أسعار خدمات طلبتها ({{count}}):\n{{changes}}'),
  row(
    'deposit.approved',
    'email',
    'merchant',
    'تمت الموافقة على إيداعك بقيمة {{amount}} {{currency}}',
    'مرحباً {{merchantName}}،\n\nتمت الموافقة على إيداعك بقيمة {{amount}} {{currency}} وأُضيف المبلغ إلى محفظتك.',
  ),
  row(
    'deposit.approved',
    'telegram',
    'merchant',
    '',
    'تمت الموافقة على الإيداع: أُضيف {{amount}} {{currency}} إلى محفظتك.',
  ),
  row(
    'invoice.paid',
    'email',
    'merchant',
    'تم دفع الفاتورة {{invoiceNumber}}',
    'مرحباً {{merchantName}}،\n\nتم دفع الفاتورة {{invoiceNumber}} ({{amount}} {{currency}}) وأُضيف المبلغ إلى محفظتك.',
  ),
  row(
    'invoice.paid',
    'telegram',
    'merchant',
    '',
    'تم دفع الفاتورة {{invoiceNumber}}: أُضيف {{amount}} {{currency}} إلى محفظتك.',
  ),
  row(
    'order.completed',
    'email',
    'merchant',
    'تم تنفيذ الطلب {{orderId}}',
    'مرحباً {{merchantName}}،\n\nتم تنفيذ الطلب {{orderId}} ({{service}}). {{resultComment}}\n\nالنتيجة متاحة في لوحتك.',
  ),
  row('order.completed', 'telegram', 'merchant', '', 'تم تنفيذ الطلب {{orderId}}. النتيجة متاحة في لوحتك.'),
  row(
    'order.failed',
    'email',
    'merchant',
    'تم رفض الطلب {{orderId}}',
    'مرحباً {{merchantName}}،\n\nتم رفض الطلب {{orderId}} ({{service}}). {{resultComment}}\n\nعاد المبلغ إلى محفظتك.',
  ),
  row('order.failed', 'telegram', 'merchant', '', 'تم رفض الطلب {{orderId}}. {{resultComment}}'),
  row('telegram.linked', 'telegram', 'merchant', '', 'تم الربط مع {{merchantName}}.'),
  row(
    'telegram.unlinked',
    'telegram',
    'merchant',
    '',
    'تم إيقاف إشعارات Telegram لـ {{merchantName}}. أنشئ رابطاً جديداً من البوابة لربط هذه المحادثة مرة أخرى.',
  ),
  row(
    'customer.magic_link',
    'email',
    'customer',
    'رابط تسجيل الدخول',
    `مرحباً {{customerName}}،\n\nاستخدم هذا الرابط لتسجيل الدخول إلى حسابك في GSM:\n\n{{link}}\n\n${LINK_FOOTER} إذا لم تطلبه، يمكنك تجاهل هذه الرسالة.`,
  ),
  row(
    'customer.password_reset',
    'email',
    'customer',
    'إعادة تعيين كلمة المرور',
    `مرحباً {{customerName}}،\n\nاستخدم هذا الرابط لاختيار كلمة مرور جديدة:\n\n{{link}}\n\n${LINK_FOOTER} ${IGNORE_PASSWORD}`,
  ),
  row(
    'customer.invited',
    'email',
    'customer',
    'حسابك في GSM جاهز',
    `مرحباً {{customerName}}،\n\nأنشأ فريقنا حساباً في GSM لك. اختر كلمة مرورك من هنا لتسجيل الدخول:\n\n{{link}}\n\n${LINK_FOOTER}`,
  ),
  row(
    'customer.email_verification',
    'email',
    'customer',
    'أكّد بريدك الإلكتروني',
    `مرحباً {{customerName}}،\n\nتم تغيير البريد الإلكتروني لحسابك في GSM إلى هذا العنوان. أكّده من هنا:\n\n{{link}}\n\n${LINK_FOOTER} إذا لم يكن هذا حسابك، يمكنك تجاهل هذه الرسالة.`,
  ),
  row(
    'order.received',
    'email',
    'customer',
    'تم تأكيد طلبك {{orderId}}',
    'مرحباً {{customerName}}، شكراً لطلبك. استلمنا {{amount}} مقابل "{{service}}". سنراسلك بالنتيجة فور تأكيد شركة الاتصالات، وعادةً خلال ساعات قليلة.',
  ),
  row(
    'order.completed',
    'email',
    'customer',
    'فتح القفل جاهز',
    'مرحباً {{customerName}}، أخبار سارة: أكدت شركة الاتصالات فتح القفل للطلب {{orderId}}. ضع شريحة من شبكة أخرى وأعد تشغيل الهاتف. إذا كان أي شيء غير واضح، ردّ على هذه الرسالة.',
  ),
  row(
    'order.failed',
    'email',
    'customer',
    'تعذّر فتح القفل للطلب {{orderId}}',
    'مرحباً {{customerName}}، رفضت شركة الاتصالات طلب فتح القفل هذا، لذلك أعدنا {{amount}} إلى بطاقتك. قد يستغرق ظهور المبلغ من 5 إلى 10 أيام. نأسف لأن الطلب لم يتم.',
  ),
  row(
    'payment.failed',
    'email',
    'customer',
    'لم تتم عملية الدفع',
    'مرحباً {{customerName}}، رفض مصرفك دفعة {{amount}} لطلب فتح القفل، لذلك لم نبدأ الطلب. لم يتم خصم أي مبلغ. يمكنك المحاولة مرة أخرى أو استخدام بطاقة أخرى.',
  ),
  row(
    'refund.declined',
    'email',
    'customer',
    'بخصوص طلب الاسترداد للطلب {{orderId}}',
    'مرحباً {{customerName}}،\n\nراجعنا طلب الاسترداد بقيمة {{amount}} للطلب {{orderId}} ولم نتمكن من الموافقة عليه.\n\nالسبب: {{reason}}\n\nإذا كانت لديك تفاصيل إضافية قد تغيّر القرار، ردّ على هذه الرسالة وسننظر في الأمر مجدداً.',
  ),
  // The support module's templates (its own English rows live in `support-templates.ts`).
  row(
    'support.reply',
    'email',
    'customer',
    'رد: {{subject}} ({{ticketNumber}})',
    'مرحباً {{customerName}}،\n\n{{message}}\n\nالتذكرة {{ticketNumber}}: {{subject}}\nاقرأ المحادثة كاملة أو ردّ من هنا: {{link}}',
  ),
  row(
    'support.ticket_received',
    'email',
    'customer',
    'استلمنا رسالتك ({{ticketNumber}})',
    'مرحباً {{customerName}}،\n\nاستلمنا رسالتك "{{subject}}" وفتحنا التذكرة {{ticketNumber}}. سيرد فريقنا عبر البريد الإلكتروني.\n\nيمكنك متابعة التذكرة وإضافة تفاصيل من هنا: {{link}}\n\nيُرجى الاحتفاظ بهذه الرسالة: الرابط خاص بك.',
  ),
  row(
    'support.csat_survey',
    'email',
    'customer',
    'كيف كانت تجربتك؟ ({{ticketNumber}})',
    'مرحباً {{customerName}}،\n\nحددنا تذكرتك {{ticketNumber}} "{{subject}}" كمحلولة. أخبرنا كيف كانت خدمتنا، يستغرق ذلك خمس ثوانٍ فقط:\n\n{{link}}\n\nإذا لم تُحل مشكلتك، اكتب في الصفحة نفسها وسنعيد فتح التذكرة.',
  ),
  row(
    'support.reply',
    'email',
    'merchant',
    'رد: {{subject}} ({{ticketNumber}})',
    'مرحباً {{merchantName}}،\n\n{{message}}\n\nالتذكرة {{ticketNumber}}: {{subject}}',
  ),
  row('support.reply', 'telegram', 'merchant', '', 'رد الدعم على {{ticketNumber}} ({{subject}}):\n{{message}}'),
];

/**
 * Writes the Arabic templates as the SQL the migration holds.
 *
 * Why: the migration is plain SQL, so the text is written once here and pasted; a spec runs the migration's data section against this
 * function so the two cannot drift (the pattern of `supportTemplatesSql`). `ON CONFLICT DO NOTHING` keeps a template staff already
 * wrote for the same event, channel, audience and language.
 *
 * @returns one `INSERT ... ON CONFLICT DO NOTHING` statement for every Arabic template
 */
export function arabicTemplatesSql(): string {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const rows = ARABIC_DEFAULT_TEMPLATES.map(
    (t) =>
      `  (${quote(t.event)}, ${quote(t.channel)}, ${quote(t.audience)}, ${quote(t.locale)}, ${quote(t.subject)}, ${quote(t.body)}, true)`,
  );
  return [
    'INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES',
    `${rows.join(',\n')}`,
    'ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;',
  ].join('\n');
}
