// The default templates of the identity events of feature 20 (merchant lifecycle and staff link mails): English emails for merchants and
// staff. Migration `0025_merchant_management_templates` inserted them (with Arabic twins that migration 0035 deletes); a spec finds every
// row of this file in it, except the events of {@link IDENTITY_SHIPPED_TEXT_ONLY}, whose text is only shipped with the code.
import { type DefaultTemplate, templatesInsertSql } from '../../../platform';

/**
 * The name of the custom migration that inserted {@link IDENTITY_DEFAULT_TEMPLATES}.
 *
 * Why: the lead renumbers migrations at merge (LEAD-DECISIONS L3); the spec reads the file name from this one constant.
 */
export const IDENTITY_TEMPLATES_MIGRATION = '0025_merchant_management_templates.sql';

const merchant = (event: string, subject: string, body: string): DefaultTemplate => ({
  event,
  channel: 'email',
  audience: 'merchant',
  subject,
  body,
});

const staff = (event: string, subject: string, body: string): DefaultTemplate => ({
  event,
  channel: 'email',
  audience: 'staff',
  subject,
  body,
});

const customer = (event: string, subject: string, body: string): DefaultTemplate => ({
  event,
  channel: 'email',
  audience: 'customer',
  subject,
  body,
});

/**
 * The events of {@link IDENTITY_DEFAULT_TEMPLATES} that no migration installed.
 *
 * Why: the notice of an API key the merchant made in the portal came after migration 0025. It is a security email, so it is always sent
 * from this shipped text (decision 047) while no stored template exists; staff who want other words add a template for the event. Nothing
 * writes this notice since decision 067 (merchants no longer create keys); the event stays registered so a notification written before still reads and sends.
 * The four mails of the shop's sign-up (decision 079: the note to an address without an account, the link that finishes a sign-up, the
 * answer to an address that already has an account, and the mail that tells the account its finish set a password) are security mails of
 * the same kind: no migration installs their text.
 * `identityTemplatesSql()` leaves these out, so a test database holds the rows production holds.
 */
export const IDENTITY_SHIPPED_TEXT_ONLY: readonly string[] = [
  'merchant.portal_api_key_created',
  'customer.no_account',
  'customer.sign_up_link',
  'customer.sign_up_existing',
  'customer.password_set',
];

/**
 * The templates the identity events start with.
 *
 * Why: a missing template sends nothing (RULES settings 10; the account link mails and the security notices are then written from their
 * shipped text, decision 047), so the mails come with the migration, except those of {@link IDENTITY_SHIPPED_TEXT_ONLY}. They live here
 * and not in the platform's `DEFAULT_TEMPLATES`: that list is checked against its own migration (LEAD-DECISIONS L2).
 */
export const IDENTITY_DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  merchant(
    'merchant.suspended',
    'Your merchant account is suspended',
    'Hi {{merchantName}},\n\nYour merchant account has been suspended. You cannot sign in, and API calls are refused, until it is reactivated. Orders that are already in progress will still be completed.\n\nIf you think this is a mistake, reply to this email or contact our support team.',
  ),
  merchant(
    'merchant.reactivated',
    'Your merchant account is active again',
    'Hi {{merchantName}},\n\nYour merchant account is active again. You can sign in and place orders: {{portalUrl}}\n\nYour earlier sessions were ended, so please sign in again.',
  ),
  merchant(
    'merchant.security_notice',
    'A security change on your merchant account',
    'Hi {{merchantName}},\n\nOur support team made this change to your account: {{change}}.\n\nIf you did not ask for it, reply to this email or contact our support team at once.',
  ),
  merchant(
    'merchant.portal_api_key_created',
    'A new API key was created in your account',
    'Hi {{merchantName}},\n\n{{change}}\n\nIf you did not create it, revoke it in the portal and change your password.',
  ),
  staff(
    'staff.invited',
    'You were invited to the GSM admin console',
    'Hi {{staffName}},\n\nYou were added to the GSM admin console. Choose your password here:\n\n{{link}}\n\nThe link works once, until {{expiresAt}}. After that, ask an owner to send a new one.',
  ),
  customer(
    'customer.no_account',
    'No account uses this email address yet',
    'Hello,\n\n{{change}}\n\nTo create your account, open this page and fill in your details: {{signUpUrl}}\n\nIf you did not ask for a sign-in link, you can ignore this email.',
  ),
  // Decision 079 (the review's S3): the reader is told that nothing exists until the link is opened, so a sign-up a stranger sent with this
  // address can simply be ignored. The guest row a sign-up names may have no name yet: the greeting names nobody.
  customer(
    'customer.sign_up_link',
    'Finish creating your account',
    'Hello,\n\nFinish creating your account: open this link to confirm your email address.\n\n{{link}}\n\nThe link works once and stops working at {{expiresAt}}. If you did not ask for this, ignore this email: no account is made until the link is opened.',
  ),
  customer(
    'customer.sign_up_existing',
    'You already have an account',
    'Hi {{customerName}},\n\nSomeone asked to create an account with this email address. You already have an account. Nothing was changed.\n\nTo sign in, open this link:\n\n{{link}}\n\nThe link works once and stops working at {{expiresAt}}. If you did not ask for this, you can ignore this email.',
  ),
  // Decision 079 (the re-review): the account's own address hears that its sign-up finish set a password. `{{change}}` is the sentence
  // "A password was set for your account just now, when its sign-up was finished." (a security notice keeps it, decision 047). The name
  // of the finish is never empty (both names are required); the sender writes "there" for an account without one.
  customer(
    'customer.password_set',
    'A password was set for your account',
    'Hi {{customerName}},\n\n{{change}}\n\nIf this was you, there is nothing to do. If it was not you, ask for a sign-in link on the sign-in page, then change the password in your account settings, or contact our support team.',
  ),
  staff(
    'staff.password_reset',
    'Choose a new password for the GSM admin console',
    'Hi {{staffName}},\n\nAn owner sent you a link to choose a new password:\n\n{{link}}\n\nThe link works once, until {{expiresAt}}. Your current password keeps working until you use it. If you did not expect this email, tell an owner.',
  ),
];

/**
 * Writes the identity templates as the SQL that installs them (today's shape: no language, one per event, channel and audience).
 *
 * Why: the text is written once here; the applied migration {@link IDENTITY_TEMPLATES_MIGRATION} keeps the shape it shipped with
 * (decision 027), so the spec finds every row of this file in it, and the test support runs this SQL. The events of
 * {@link IDENTITY_SHIPPED_TEXT_ONLY} have no stored row in production, so none is written here.
 *
 * @returns one `INSERT ... ON CONFLICT DO NOTHING` statement for every identity template a migration installed
 */
export function identityTemplatesSql(): string {
  return templatesInsertSql(
    IDENTITY_DEFAULT_TEMPLATES.filter((template) => !IDENTITY_SHIPPED_TEXT_ONLY.includes(template.event)),
  );
}
