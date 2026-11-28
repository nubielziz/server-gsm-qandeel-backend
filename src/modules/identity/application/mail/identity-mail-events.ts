// The notification events of the identity module beyond the three merchant link mails (feature 20): the merchant lifecycle mails, the
// two staff link mails, the three mails of the shop's sign-up (decision 079: the link that finishes it, the answer to an address that
// already has an account, and the note to an address without one) and the mail that says its finish set a password. Registered with the
// platform's registry at boot, in the API and in the worker (IdentityMailEventsModule).
import { SIGN_UP_MAIL_EVENTS } from '../../domain/account-mail';
import type { NotificationEventDefinition } from '../../../platform';

/** A merchant's account was suspended. */
export const MERCHANT_SUSPENDED_EVENT = 'merchant.suspended';
/** A suspended merchant's account was reactivated. */
export const MERCHANT_REACTIVATED_EVENT = 'merchant.reactivated';
/** Staff changed something security-relevant on the merchant's account (temporary password, 2FA reset, API key, email change). */
export const MERCHANT_SECURITY_NOTICE_EVENT = 'merchant.security_notice';
/**
 * The merchant created an API key in the portal: the notice says so, and does not name the support team. Nothing sends it since decision 067
 * (merchants no longer create keys); it stays registered with its shipped text so notifications written before still read and send.
 */
export const MERCHANT_PORTAL_API_KEY_CREATED_EVENT = 'merchant.portal_api_key_created';
/** A staff member was invited to the console: the link where they choose a password. */
export const STAFF_INVITED_EVENT = 'staff.invited';
/** A staff member got a link to choose a new password. */
export const STAFF_PASSWORD_RESET_EVENT = 'staff.password_reset';
/**
 * A sign-in link was asked for an address that has no account: the note names the shop's sign-up page (decision 079: a link no longer
 * makes an account).
 */
export const CUSTOMER_NO_ACCOUNT_EVENT = 'customer.no_account';
/**
 * The finish of a sign-up set the account's first password: the account's own address is told (decision 079, its re-review). The account
 * made the change itself, so the text never says that support did.
 */
export const CUSTOMER_PASSWORD_SET_EVENT = 'customer.password_set';
/**
 * The sentence of `{{change}}` in {@link CUSTOMER_PASSWORD_SET_EVENT}.
 *
 * Why: a security notice keeps `{{change}}` in its text (decision 047: a stored template may not drop it), and an event whose text only
 * ships with the code is sent from that text only when it is a security event. The code decides the words, never free text.
 */
export const PASSWORD_SET_SENTENCE = 'A password was set for your account just now, when its sign-up was finished.';
/** A sign-up for an address without an account: the link that makes the account ("finish creating your account", decision 079). */
export const CUSTOMER_SIGN_UP_LINK_EVENT = SIGN_UP_MAIL_EVENTS.sign_up_link;
/** A sign-up for an address that already has an account: its ordinary sign-in link, and nothing was changed (decision 079). */
export const CUSTOMER_SIGN_UP_EXISTING_EVENT = SIGN_UP_MAIL_EVENTS.sign_up_existing;

const MERCHANT_SAMPLE = {
  merchantName: 'Zain Mobile Hub',
  portalUrl: 'https://shop.example.com/account',
  change: 'a temporary password was set for your account',
} as const;

const STAFF_SAMPLE = {
  staffName: 'Nadia Hamdan',
  link: 'https://admin.example.com/set-password?token=example',
  expiresAt: '2026-11-01 11:00 UTC',
} as const;

const CUSTOMER_SAMPLE = {
  change: 'A sign-in link was asked for this email address, and no account uses it yet.',
  signUpUrl: 'https://shop.example.com/en/sign-up',
  customerName: 'Daniel',
  link: 'https://shop.example.com/sign-in?token=example',
  expiresAt: '2026-11-01 11:00 UTC',
} as const;

const SAMPLES: Readonly<Record<'merchant' | 'staff' | 'customer', Readonly<Record<string, string>>>> = {
  merchant: MERCHANT_SAMPLE,
  staff: STAFF_SAMPLE,
  customer: CUSTOMER_SAMPLE,
};

const event = (
  audience: 'merchant' | 'staff' | 'customer',
  spec: Pick<NotificationEventDefinition, 'key' | 'label' | 'description' | 'variables'> &
    Partial<Pick<NotificationEventDefinition, 'security' | 'secretLink' | 'namedAddress' | 'sample'>>,
): NotificationEventDefinition => {
  const source = SAMPLES[audience];
  return {
    ...spec,
    audience,
    channels: ['email'],
    sample: { ...Object.fromEntries(spec.variables.map((name) => [name, source[name] ?? ''])), ...spec.sample },
    // Always sent, never in a merchant's preferences, delivered to a suspended recipient (the suspension mail needs it).
    transactional: true,
    defaultEmail: true,
  };
};

/**
 * The events the identity module registers for feature 20.
 *
 * Why: LEAD-DECISIONS section 6 (merchant management): transactional emails on suspension and
 * reactivation, a security notice after staff actions on the account, and the staff invitation and reset links; decision 079: the two link
 * mails of the shop's sign-up, the note that answers a sign-in link asked for an address without an account, and the mail that tells the
 * account its sign-up finish set a password.
 * Transactional means: sent whatever the recipient's preferences say, and also to a suspended recipient.
 */
export const IDENTITY_MAIL_EVENTS: readonly NotificationEventDefinition[] = [
  event('merchant', {
    key: MERCHANT_SUSPENDED_EVENT,
    label: 'Account suspended',
    description: 'Staff suspended the merchant. The staff reason is internal and is not in the mail.',
    variables: ['merchantName'],
  }),
  event('merchant', {
    key: MERCHANT_REACTIVATED_EVENT,
    label: 'Account reactivated',
    description: 'Staff reactivated a suspended merchant.',
    variables: ['merchantName', 'portalUrl'],
  }),
  event('merchant', {
    key: MERCHANT_SECURITY_NOTICE_EVENT,
    label: 'Security change by support',
    description:
      'Staff set a temporary password, turned off two-factor sign-in, created an API key or changed the email address of the merchant; for an email change it goes to the address before the change.',
    variables: ['merchantName', 'change'],
    security: true,
    namedAddress: true,
  }),
  event('merchant', {
    key: MERCHANT_PORTAL_API_KEY_CREATED_EVENT,
    label: 'API key created in the portal',
    description:
      'No longer sent: merchants do not create API keys since decision 067. It stays so that notices written before still read. A key staff create sends the security change by support.',
    variables: ['merchantName', 'change'],
    sample: { change: "A new API key was created in your account's portal." },
    security: true,
  }),
  event('staff', {
    key: STAFF_INVITED_EVENT,
    label: 'Staff invitation',
    description: 'A staff member was added to the console: the link where they choose a password.',
    variables: ['staffName', 'link', 'expiresAt'],
    security: true,
    secretLink: true,
  }),
  event('staff', {
    key: STAFF_PASSWORD_RESET_EVENT,
    label: 'Staff password link',
    description: 'An owner sent a staff member a link to choose a new password.',
    variables: ['staffName', 'link', 'expiresAt'],
    security: true,
    secretLink: true,
  }),
  // A security notice (decision 047): it answers a request about the sign-in of the address, so a switched-off or missing template never
  // stops it (the shipped text is sent), and its text keeps `{{change}}`, which says what was asked. The sign-up page is no credential.
  // It goes to the address that was typed, which no account row holds (`namedAddress`: the review of decision 079, so that the request
  // leaves no guest row behind).
  event('customer', {
    key: CUSTOMER_NO_ACCOUNT_EVENT,
    label: 'No account yet',
    description:
      'Sent instead of a sign-in link when a link is asked for an email address that has no account: it names the shop’s sign-up page.',
    variables: ['change', 'signUpUrl'],
    security: true,
    namedAddress: true,
  }),
  // The two link mails of a sign-up (decision 079, the review's S3): sign-in links of the retail rank, so security mails whose `{{link}}`
  // is a credential, sent by the account mail job like `customer.magic_link`.
  event('customer', {
    key: CUSTOMER_SIGN_UP_LINK_EVENT,
    label: 'Finish creating your account',
    description:
      'Sent when someone signs up with this email address and no account uses it yet: the link that makes the account. No account is ' +
      'made until it is opened.',
    variables: ['customerName', 'link', 'expiresAt'],
    security: true,
    secretLink: true,
  }),
  event('customer', {
    key: CUSTOMER_SIGN_UP_EXISTING_EVENT,
    label: 'You already have an account',
    description:
      'Sent when someone signs up with an email address that already has an account: nothing was changed, and the mail carries the ' +
      'ordinary sign-in link.',
    variables: ['customerName', 'link', 'expiresAt'],
    security: true,
    secretLink: true,
  }),
  // A security notice (decision 047) to the account's own address, in the transaction of the finish: a missing or switched-off template
  // never stops it. It names no staff action: the owner of the account chose the password.
  event('customer', {
    key: CUSTOMER_PASSWORD_SET_EVENT,
    label: 'A password was set',
    description:
      'Sent to the account’s own address when the finish of its sign-up set the first password: if it was not the owner, the mail says how ' +
      'to take the account back.',
    variables: ['customerName', 'change'],
    sample: { change: PASSWORD_SET_SENTENCE },
    security: true,
  }),
];
