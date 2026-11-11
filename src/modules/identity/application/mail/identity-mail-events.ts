// The notification events of the identity module beyond the three merchant link mails (feature 20): the merchant lifecycle mails and the
// two staff link mails. Registered with the platform's registry at boot, in the API and in the worker (IdentityMailEventsModule).
import type { NotificationEventDefinition } from '../../../platform';

/** A merchant's account was approved (`pending` to `active`). */
export const MERCHANT_APPROVED_EVENT = 'merchant.approved';
/** A merchant's account was suspended (also how staff decline an application). */
export const MERCHANT_SUSPENDED_EVENT = 'merchant.suspended';
/** A suspended merchant's account was reactivated. */
export const MERCHANT_REACTIVATED_EVENT = 'merchant.reactivated';
/** Staff approved the merchant's identity verification (KYC). */
export const MERCHANT_KYC_APPROVED_EVENT = 'merchant.kyc_approved';
/** Staff rejected the merchant's identity verification (KYC); the mail carries the staff note. */
export const MERCHANT_KYC_REJECTED_EVENT = 'merchant.kyc_rejected';
/** Staff changed something security-relevant on the merchant's account (temporary password, 2FA reset, API key). */
export const MERCHANT_SECURITY_NOTICE_EVENT = 'merchant.security_notice';
/** A staff member was invited to the console: the link where they choose a password. */
export const STAFF_INVITED_EVENT = 'staff.invited';
/** A staff member got a link to choose a new password. */
export const STAFF_PASSWORD_RESET_EVENT = 'staff.password_reset';

const MERCHANT_SAMPLE = {
  merchantName: 'Zain Mobile Hub',
  portalUrl: 'https://shop.example.com/merchant',
  reason: 'The photo of the document is not readable.',
  change: 'a temporary password was set for your account',
} as const;

const STAFF_SAMPLE = {
  staffName: 'Nadia Hamdan',
  link: 'https://admin.example.com/set-password?token=example',
  expiresAt: '2026-11-01 11:00 UTC',
} as const;

const event = (
  audience: 'merchant' | 'staff',
  spec: Pick<NotificationEventDefinition, 'key' | 'label' | 'description' | 'variables'>,
): NotificationEventDefinition => {
  const source: Readonly<Record<string, string>> = audience === 'merchant' ? MERCHANT_SAMPLE : STAFF_SAMPLE;
  return {
    ...spec,
    audience,
    channels: ['email'],
    sample: Object.fromEntries(spec.variables.map((name) => [name, source[name] ?? ''])),
    // Always sent, never in a merchant's preferences, delivered to a suspended recipient (the suspension mail needs it).
    transactional: true,
    defaultEmail: true,
    defaultTelegram: false,
  };
};

/**
 * The events the identity module registers for feature 20.
 *
 * Why: LEAD-DECISIONS section 6 (merchant management): transactional emails on approval, KYC decision, suspension and
 * reactivation, a security notice after staff actions on the account, and the staff invitation and reset links.
 * Transactional means: sent whatever the recipient's preferences say, and also to a suspended recipient.
 */
export const IDENTITY_MAIL_EVENTS: readonly NotificationEventDefinition[] = [
  event('merchant', {
    key: MERCHANT_APPROVED_EVENT,
    label: 'Account approved',
    description: 'Staff approved a pending merchant: tells them they can sign in and trade.',
    variables: ['merchantName', 'portalUrl'],
  }),
  event('merchant', {
    key: MERCHANT_SUSPENDED_EVENT,
    label: 'Account suspended',
    description:
      'Staff suspended the merchant (or declined an application). The staff reason is internal and is not in the mail.',
    variables: ['merchantName'],
  }),
  event('merchant', {
    key: MERCHANT_REACTIVATED_EVENT,
    label: 'Account reactivated',
    description: 'Staff reactivated a suspended merchant.',
    variables: ['merchantName', 'portalUrl'],
  }),
  event('merchant', {
    key: MERCHANT_KYC_APPROVED_EVENT,
    label: 'Identity verification approved',
    description: 'Staff approved the merchant’s identity documents.',
    variables: ['merchantName'],
  }),
  event('merchant', {
    key: MERCHANT_KYC_REJECTED_EVENT,
    label: 'Identity verification rejected',
    description: 'Staff rejected the merchant’s identity documents; the mail carries the staff note.',
    variables: ['merchantName', 'reason'],
  }),
  event('merchant', {
    key: MERCHANT_SECURITY_NOTICE_EVENT,
    label: 'Security change by support',
    description:
      'Staff set a temporary password, turned off two-factor sign-in or created an API key for the merchant.',
    variables: ['merchantName', 'change'],
  }),
  event('staff', {
    key: STAFF_INVITED_EVENT,
    label: 'Staff invitation',
    description: 'A staff member was added to the console: the link where they choose a password.',
    variables: ['staffName', 'link', 'expiresAt'],
  }),
  event('staff', {
    key: STAFF_PASSWORD_RESET_EVENT,
    label: 'Staff password link',
    description: 'An owner sent a staff member a link to choose a new password.',
    variables: ['staffName', 'link', 'expiresAt'],
  }),
];
