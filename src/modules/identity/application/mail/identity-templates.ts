// The default templates of the identity events of feature 20 (merchant lifecycle and staff link mails): English and Arabic for merchants,
// English for staff. Migration `0025_merchant_management_templates` inserts the same rows; a test keeps the two equal.
import type { DefaultTemplate } from '../../../platform';

/**
 * A default template of an identity event: the platform's shape with the language widened to English or Arabic.
 *
 * Why: the platform's `DefaultTemplate` is English only; widening it is feature 23's change to a platform file, so this feature keeps its own type.
 */
export type IdentityDefaultTemplate = Omit<DefaultTemplate, 'locale'> & { readonly locale: 'en' | 'ar' };

/**
 * The name of the custom migration that inserts {@link IDENTITY_DEFAULT_TEMPLATES}.
 *
 * Why: the lead renumbers migrations at merge (LEAD-DECISIONS L3); the spec reads the file name from this one constant.
 */
export const IDENTITY_TEMPLATES_MIGRATION = '0025_merchant_management_templates.sql';

const merchant = (event: string, locale: 'en' | 'ar', subject: string, body: string): IdentityDefaultTemplate => ({
  event,
  channel: 'email',
  audience: 'merchant',
  locale,
  subject,
  body,
});

const staff = (event: string, subject: string, body: string): IdentityDefaultTemplate => ({
  event,
  channel: 'email',
  audience: 'staff',
  locale: 'en',
  subject,
  body,
});

/**
 * The templates the identity events start with.
 *
 * Why: a missing template sends nothing (RULES settings 10), so the mails come with the migration. They live here and not in the
 * platform's `DEFAULT_TEMPLATES`: that list is checked against its own migration (LEAD-DECISIONS L2).
 */
export const IDENTITY_DEFAULT_TEMPLATES: readonly IdentityDefaultTemplate[] = [
  merchant(
    'merchant.approved',
    'en',
    'Your merchant account is approved',
    'Hi {{merchantName}},\n\nGood news: our team approved your merchant account. You can now add funds, place orders and create API keys.\n\nSign in here: {{portalUrl}}\n\nIf you have not chosen a password yet, use "Forgot password" on the sign-in page.',
  ),
  merchant(
    'merchant.approved',
    'ar',
    'تمت الموافقة على حساب التاجر الخاص بك',
    'مرحباً {{merchantName}}،\n\nوافق فريقنا على حساب التاجر الخاص بك. يمكنك الآن شحن الرصيد وتقديم الطلبات وإنشاء مفاتيح API.\n\nسجّل الدخول من هنا: {{portalUrl}}\n\nإذا لم تختر كلمة مرور بعد، استخدم «نسيت كلمة المرور» في صفحة تسجيل الدخول.',
  ),
  merchant(
    'merchant.suspended',
    'en',
    'Your merchant account is suspended',
    'Hi {{merchantName}},\n\nYour merchant account has been suspended. You cannot sign in, and API calls are refused, until it is reactivated. Orders that are already in progress will still be completed.\n\nIf you think this is a mistake, reply to this email or contact our support team.',
  ),
  merchant(
    'merchant.suspended',
    'ar',
    'تم إيقاف حساب التاجر الخاص بك',
    'مرحباً {{merchantName}}،\n\nتم إيقاف حساب التاجر الخاص بك. لا يمكنك تسجيل الدخول، وتُرفض طلبات الـ API، إلى أن يُعاد تفعيله. الطلبات الجارية ستُستكمل.\n\nإذا كنت تعتقد أن هذا خطأ، ردّ على هذا البريد أو تواصل مع فريق الدعم.',
  ),
  merchant(
    'merchant.reactivated',
    'en',
    'Your merchant account is active again',
    'Hi {{merchantName}},\n\nYour merchant account is active again. You can sign in and place orders: {{portalUrl}}\n\nYour earlier sessions were ended, so please sign in again.',
  ),
  merchant(
    'merchant.reactivated',
    'ar',
    'تمت إعادة تفعيل حساب التاجر الخاص بك',
    'مرحباً {{merchantName}}،\n\nأُعيد تفعيل حساب التاجر الخاص بك. يمكنك تسجيل الدخول وتقديم الطلبات: {{portalUrl}}\n\nانتهت جلساتك السابقة، لذا يُرجى تسجيل الدخول من جديد.',
  ),
  merchant(
    'merchant.kyc_approved',
    'en',
    'Your identity verification is approved',
    'Hi {{merchantName}},\n\nWe reviewed your documents and your identity verification is approved. Thank you.',
  ),
  merchant(
    'merchant.kyc_approved',
    'ar',
    'تمت الموافقة على توثيق هويتك',
    'مرحباً {{merchantName}}،\n\nراجعنا مستنداتك وتمت الموافقة على توثيق هويتك. شكراً لك.',
  ),
  merchant(
    'merchant.kyc_rejected',
    'en',
    'Your identity verification needs attention',
    'Hi {{merchantName}},\n\nWe could not approve your identity verification.\n\nReason: {{reason}}\n\nYou can upload new documents from the Verification page of your account.',
  ),
  merchant(
    'merchant.kyc_rejected',
    'ar',
    'توثيق هويتك يحتاج إلى مراجعة',
    'مرحباً {{merchantName}}،\n\nلم نتمكن من الموافقة على توثيق هويتك.\n\nالسبب: {{reason}}\n\nيمكنك رفع مستندات جديدة من صفحة التوثيق في حسابك.',
  ),
  merchant(
    'merchant.security_notice',
    'en',
    'A security change on your merchant account',
    'Hi {{merchantName}},\n\nOur support team made this change to your account: {{change}}.\n\nIf you did not ask for it, reply to this email or contact our support team at once.',
  ),
  merchant(
    'merchant.security_notice',
    'ar',
    'تغيير أمني في حساب التاجر الخاص بك',
    'مرحباً {{merchantName}}،\n\nأجرى فريق الدعم هذا التغيير على حسابك: {{change}}.\n\nإذا لم تطلب ذلك، ردّ على هذا البريد أو تواصل مع فريق الدعم فوراً.',
  ),
  staff(
    'staff.invited',
    'You were invited to the GSM admin console',
    'Hi {{staffName}},\n\nYou were added to the GSM admin console. Choose your password here:\n\n{{link}}\n\nThe link works once, until {{expiresAt}}. After that, ask an owner to send a new one.',
  ),
  staff(
    'staff.password_reset',
    'Choose a new password for the GSM admin console',
    'Hi {{staffName}},\n\nAn owner sent you a link to choose a new password:\n\n{{link}}\n\nThe link works once, until {{expiresAt}}. Your current password keeps working until you use it. If you did not expect this email, tell an owner.',
  ),
];

/**
 * Writes the identity templates as the SQL the migration holds.
 *
 * Why: the migration is plain SQL, so the text is written once here and pasted; a spec reads the migration named by
 * {@link IDENTITY_TEMPLATES_MIGRATION} and compares (the pattern of `supportTemplatesSql`).
 *
 * @returns one `INSERT ... ON CONFLICT DO NOTHING` statement for every identity template
 */
export function identityTemplatesSql(): string {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const rows = IDENTITY_DEFAULT_TEMPLATES.map(
    (t) =>
      `  (${quote(t.event)}, ${quote(t.channel)}, ${quote(t.audience)}, ${quote(t.locale)}, ${quote(t.subject)}, ${quote(t.body)}, true)`,
  );
  return [
    'INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES',
    `${rows.join(',\n')}`,
    'ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;',
  ].join('\n');
}
