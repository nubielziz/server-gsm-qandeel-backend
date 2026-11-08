// Identity tables (map domain A): staff, roles, merchants, sessions, one-time tokens, API keys, KYC, IP rules.
// Conventions: decision 027; schema additions: MISMATCHES B116; ownership: scripts/module-map.mjs.
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  cidr,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  bigId,
  bigintList,
  createdAt,
  fk,
  inList,
  jsonObject,
  lower,
  pk,
  textList,
  timestampTz,
  updatedAt,
} from '../../../infra/db/columns';
import { clientGroups } from '../../catalog/db/schema';

/**
 * Staff account states: `invited` until the first sign-in, then `active`, or `suspended` (reversible).
 *
 * Why: the console's staff wire enum (GET /admin/staff) and the admin-team scenario.
 */
export const STAFF_STATUSES = ['invited', 'active', 'suspended'] as const;

/** One value of {@link STAFF_STATUSES}. */
export type StaffStatus = (typeof STAFF_STATUSES)[number];

/**
 * Merchant account states: `pending` after the invitation, `active`, or `suspended`.
 *
 * Why: the console's merchant wire enum (GET /admin/clients).
 */
export const CLIENT_STATUSES = ['active', 'suspended', 'pending'] as const;

/** One value of {@link CLIENT_STATUSES}. */
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/**
 * A merchant's identity-verification state: `none` until a request is sent.
 *
 * Why: the console's `kycStatus` wire enum (GET /admin/clients).
 */
export const KYC_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;

/** One value of {@link KYC_STATUSES}. */
export type KycStatus = (typeof KYC_STATUSES)[number];

/**
 * States of one KYC request.
 *
 * Why: the console's KYC queue wire enum (GET /admin/kyc-submissions).
 */
export const KYC_SUBMISSION_STATUSES = ['pending', 'approved', 'rejected'] as const;

/** One value of {@link KYC_SUBMISSION_STATUSES}. */
export type KycSubmissionStatus = (typeof KYC_SUBMISSION_STATUSES)[number];

/**
 * Who a session or one-time token belongs to: staff, a merchant (`client`) or a storefront customer.
 *
 * Why: MISMATCHES B9: the sessions table holds all three subjects (decision 018).
 */
export const SUBJECT_TYPES = ['staff', 'client', 'customer'] as const;

/** One value of {@link SUBJECT_TYPES}. */
export type SubjectType = (typeof SUBJECT_TYPES)[number];

/**
 * What a one-time token is for: a staff or merchant invitation, a password reset, an email verification, a magic sign-in
 * link or the link that connects a merchant's Telegram chat.
 *
 * Why: RESOLUTIONS identity-platform-2 settles the vocabulary: the invite link of POST /admin/clients uses `invite`
 * (decisions 010 and 019); staff use `invite` and `reset` today. `telegram_link` is feature 12a's (MISMATCHES B165): the token
 * of `POST /client/telegram/link`, spent when the merchant sends `/start <token>` to the bot.
 */
export const AUTH_TOKEN_PURPOSES = ['invite', 'reset', 'verify_email', 'magic_link', 'telegram_link'] as const;

/** One value of {@link AUTH_TOKEN_PURPOSES}. */
export type AuthTokenPurpose = (typeof AUTH_TOKEN_PURPOSES)[number];

/**
 * Sign-in step a session has reached; only `active` is a full session.
 *
 * Why: decision 018 and MISMATCHES B106: the staff sign-in is a multi-step flow.
 */
export const SESSION_STAGES = ['pending_password', 'pending_totp_setup', 'pending_totp', 'active'] as const;

/** One value of {@link SESSION_STAGES}. */
export type SessionStage = (typeof SESSION_STAGES)[number];

/**
 * An IP rule either allows or blocks an address range.
 *
 * Why: the console's IP rule wire enum (GET /admin/ip-rules); a block beats an allow.
 */
export const IP_RULE_KINDS = ['allow', 'block'] as const;

/** One value of {@link IP_RULE_KINDS}. */
export type IpRuleKind = (typeof IP_RULE_KINDS)[number];

/**
 * Which audience an IP rule applies to.
 *
 * Why: the console's IP rule wire enum (scenario ip-rules).
 */
export const IP_RULE_SCOPES = ['store', 'api', 'admin', 'all'] as const;

/** One value of {@link IP_RULE_SCOPES}. */
export type IpRuleScope = (typeof IP_RULE_SCOPES)[number];

/**
 * Who created an IP rule: a staff member or the risk engine.
 *
 * Why: the console's IP rule wire enum.
 */
export const IP_RULE_SOURCES = ['manual', 'auto'] as const;

/** One value of {@link IP_RULE_SOURCES}. */
export type IpRuleSource = (typeof IP_RULE_SOURCES)[number];

/**
 * Admin console staff. Two-factor authentication is mandatory. Status is invited until the first sign-in, then
 * active, or suspended (a reversible stop that ends the sessions and keeps the record). The last owner and the staff
 * member themselves cannot be suspended. Allowed addresses live in ip_rules, not in a column.
 *
 * Why: Console sign-in, roles and suspension (scenario admin-team, routes /admin/staff and /admin/auth/*).
 */
export const staffUsers = pgTable(
  'staff_users',
  {
    id: pk(),
    /** unique case-insensitively */
    email: text().notNull(),
    /** null until the invitation is accepted or a temporary password is set (argon2id, decision 007) */
    passwordHash: text(),
    name: text().notNull(),
    roleId: fk((): AnyPgColumn => roles.id).notNull(),
    /** AES-GCM text of decision 019; null until 2FA setup; while `twofa_enabled` is false it is the pending secret */
    totpSecretEnc: text(),
    /**
     * the last TOTP time step accepted for this account (RFC 6238 replay rule: a step is never accepted twice); null until
     * the first accepted code and after a new secret. Schema addition for P2.6 (MISMATCHES B116 style).
     */
    totpLastStep: bigId(),
    twofaEnabled: boolean().notNull().default(false),
    mustChangePassword: boolean().notNull().default(false),
    passwordChangedAt: timestampTz(),
    status: text().$type<StaffStatus>().notNull().default('invited'),
    suspendedAt: timestampTz(),
    suspendedReason: text(),
    suspendedBy: fk((): AnyPgColumn => staffUsers.id),
    /** null for the account that was set up outside the console */
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    lastLoginAt: timestampTz(),
    lastLoginIp: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('staff_users_email_uq').on(lower(t.email)),
    check('staff_users_status_check', inList(t.status, STAFF_STATUSES)),
    index('staff_users_role_id_idx').on(t.roleId),
    index('staff_users_status_idx').on(t.status),
    index('staff_users_suspended_by_idx').on(t.suspendedBy),
    index('staff_users_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `staff_users`. */
export type StaffUser = typeof staffUsers.$inferSelect;

/** A row to insert into `staff_users`. */
export type NewStaffUser = typeof staffUsers.$inferInsert;

/**
 * Roles and their permissions (RBAC).
 *
 * Why: Permission sets (RBAC); an Owner is a member of a role that contains `*` (decision 018, MISMATCHES B113).
 */
export const roles = pgTable(
  'roles',
  {
    id: pk(),
    name: text().notNull(),
    /** permission strings as stored: `*`, `area:*` or `area:action` */
    permissions: textList(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('roles_name_uq').on(lower(t.name))],
);

/** A row read from `roles`. */
export type Role = typeof roles.$inferSelect;

/** A row to insert into `roles`. */
export type NewRole = typeof roles.$inferInsert;

/**
 * B2B merchants; username is the Dhru username.
 *
 * Why: The B2B merchants who order through Dhru, REST v1 and the portal (routes /admin/clients, /client/*).
 */
export const clients = pgTable(
  'clients',
  {
    id: pk(),
    /** the Dhru username; unique case-insensitively */
    username: text().notNull(),
    /** unique case-insensitively */
    email: text().notNull(),
    /** null until the merchant accepts the invitation */
    passwordHash: text(),
    name: text().notNull(),
    company: text().notNull().default(''),
    phone: text().notNull().default(''),
    country: text().notNull().default(''),
    groupId: fk((): AnyPgColumn => clientGroups.id).notNull(),
    status: text().$type<ClientStatus>().notNull().default('pending'),
    kycStatus: text().$type<KycStatus>().notNull().default('none'),
    referredById: fk((): AnyPgColumn => clients.id),
    referralCode: text().notNull(),
    /** optional TOTP for merchants (decision 018); while `twofa_enabled` is false it is the pending secret of a setup */
    totpSecretEnc: text(),
    /** false while the secret is only pending, or when the merchant has none; schema addition B116 (feature 2b) */
    twofaEnabled: boolean().notNull().default(false),
    /**
     * the last TOTP time step accepted for this merchant (RFC 6238 replay rule: a step is never accepted twice); null until
     * the first accepted code and after a new secret. Schema addition B116 (feature 2b), same rule as
     * `staff_users.totp_last_step`.
     */
    totpLastStep: bigId(),
    /** when the merchant last chose or changed the password; null until the first one; schema addition B116 (feature 2b) */
    passwordChangedAt: timestampTz(),
    emailVerifiedAt: timestampTz(),
    /** external id from Telegram, kept as text */
    telegramChatId: text(),
    notificationPrefs: jsonObject(),
    /** schema addition B116 */
    suspendedAt: timestampTz(),
    /** schema addition B116 */
    suspendedReason: text(),
    /** schema addition B116 */
    suspendedBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('clients_username_uq').on(lower(t.username)),
    uniqueIndex('clients_email_uq').on(lower(t.email)),
    uniqueIndex('clients_referral_code_uq').on(t.referralCode),
    // One chat belongs to one merchant (B165: a chat linked to another merchant moves); two parallel links cannot both win.
    uniqueIndex('clients_telegram_chat_uq')
      .on(t.telegramChatId)
      .where(sql`${t.telegramChatId} is not null`),
    check('clients_status_check', inList(t.status, CLIENT_STATUSES)),
    check('clients_kyc_status_check', inList(t.kycStatus, KYC_STATUSES)),
    index('clients_group_id_idx').on(t.groupId),
    index('clients_status_idx').on(t.status),
    index('clients_name_idx').on(t.name),
    index('clients_referred_by_id_idx').on(t.referredById),
    index('clients_suspended_by_idx').on(t.suspendedBy),
  ],
);

/** A row read from `clients`. */
export type Client = typeof clients.$inferSelect;

/** A row to insert into `clients`. */
export type NewClient = typeof clients.$inferInsert;

/**
 * Sign-in sessions for staff, merchants and customers (magic link).
 *
 * Why: Opaque sign-in sessions for staff, merchants and customers, stored as keyed hashes (decisions 018, 019).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: pk(),
    /** HMAC-SHA256 of the cookie token (decision 019), hex */
    tokenHash: text().notNull(),
    subjectType: text().$type<SubjectType>().notNull(),
    /** polymorphic: staff_users, clients or customers by subject_type */
    subjectId: bigId().notNull(),
    /** schema addition B116 */
    stage: text().$type<SessionStage>().notNull(),
    ip: text().notNull(),
    userAgent: text().notNull().default(''),
    /** written at most once a minute (decision 018) */
    lastSeenAt: timestampTz().notNull().defaultNow(),
    expiresAt: timestampTz().notNull(),
    revokedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    check('sessions_subject_type_check', inList(t.subjectType, SUBJECT_TYPES)),
    check('sessions_stage_check', inList(t.stage, SESSION_STAGES)),
    index('sessions_subject_idx').on(t.subjectType, t.subjectId),
    index('sessions_active_idx')
      .on(t.subjectType, t.subjectId)
      .where(sql`${t.revokedAt} is null`),
    index('sessions_last_seen_idx').on(t.lastSeenAt.desc()),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);

/** A row read from `sessions`. */
export type Session = typeof sessions.$inferSelect;

/** A row to insert into `sessions`. */
export type NewSession = typeof sessions.$inferInsert;

/**
 * One-time tokens for invite and password-reset links for merchants, customers and staff, and for link sign-in and
 * email verification: hash only, valid for one hour and one use.
 *
 * Why: Single-use invite, reset, magic-link and verification tokens, hash only, valid one hour (decisions 010, 019).
 */
export const authTokens = pgTable(
  'auth_tokens',
  {
    id: pk(),
    purpose: text().$type<AuthTokenPurpose>().notNull(),
    subjectType: text().$type<SubjectType>().notNull(),
    /** polymorphic: staff_users, clients or customers by subject_type */
    subjectId: bigId().notNull(),
    tokenHash: text().notNull(),
    expiresAt: timestampTz().notNull(),
    usedAt: timestampTz(),
    ip: text(),
    /** the staff member who issued the link; null for self-service links */
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('auth_tokens_token_hash_uq').on(t.tokenHash),
    check('auth_tokens_subject_type_check', inList(t.subjectType, SUBJECT_TYPES)),
    check('auth_tokens_purpose_check', inList(t.purpose, AUTH_TOKEN_PURPOSES)),
    index('auth_tokens_subject_idx').on(t.subjectType, t.subjectId, t.purpose, t.createdAt.desc()),
    index('auth_tokens_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `auth_tokens`. */
export type AuthToken = typeof authTokens.$inferSelect;

/** A row to insert into `auth_tokens`. */
export type NewAuthToken = typeof authTokens.$inferInsert;

/**
 * Merchant API keys, stored as a hash.
 *
 * Why: Merchant credentials for REST v1 and Dhru: looked up by hash, shown by prefix (decisions 018, 019).
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: pk(),
    clientId: fk((): AnyPgColumn => clients.id).notNull(),
    name: text().notNull(),
    /** first 8 characters of the key, safe to display */
    prefix: text().notNull(),
    keyHash: text().notNull(),
    scopes: textList(),
    /** empty means any address */
    allowedIps: cidr().array().notNull().default([]),
    rateLimitPerMin: integer().notNull(),
    lastUsedAt: timestampTz(),
    lastUsedIp: text(),
    expiresAt: timestampTz(),
    revokedAt: timestampTz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('api_keys_key_hash_uq').on(t.keyHash), index('api_keys_client_id_idx').on(t.clientId)],
);

/** A row read from `api_keys`. */
export type ApiKey = typeof apiKeys.$inferSelect;

/** A row to insert into `api_keys`. */
export type NewApiKey = typeof apiKeys.$inferInsert;

/**
 * Merchant identity-verification (KYC) requests.
 *
 * Why: Merchant identity-verification queue reviewed by staff (routes /admin/kyc-submissions, /client/kyc).
 */
export const kycSubmissions = pgTable(
  'kyc_submissions',
  {
    id: pk(),
    clientId: fk((): AnyPgColumn => clients.id).notNull(),
    status: text().$type<KycSubmissionStatus>().notNull().default('pending'),
    /** uploaded documents (files.id); the database cannot enforce array elements */
    fileIds: bigintList(),
    reviewedBy: fk((): AnyPgColumn => staffUsers.id),
    reviewedAt: timestampTz(),
    /** the reviewer's note or the rejection reason */
    note: text().notNull().default(''),
    /** what the merchant wrote when it submitted (B161); never shown to the console */
    submittedNote: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('kyc_submissions_status_check', inList(t.status, KYC_SUBMISSION_STATUSES)),
    // One request under review per merchant (B161: a second submit while one is pending is refused).
    uniqueIndex('kyc_submissions_one_pending_uq')
      .on(t.clientId)
      .where(sql`${t.status} = 'pending'`),
    index('kyc_submissions_status_created_idx').on(t.status, t.createdAt.desc()),
    index('kyc_submissions_client_id_idx').on(t.clientId),
    index('kyc_submissions_reviewed_by_idx').on(t.reviewedBy),
  ],
);

/** A row read from `kyc_submissions`. */
export type KycSubmission = typeof kycSubmissions.$inferSelect;

/** A row to insert into `kyc_submissions`. */
export type NewKycSubmission = typeof kycSubmissions.$inferInsert;

/**
 * Network rules checked before any other logic: allow addresses for the admin console, and block an address or range
 * for one audience (storefront, API or admin) or for all. A block beats an allow. Restricting the console to the
 * allowlist is a switch in settings. Active rules are loaded into Redis, so no query runs per request.
 *
 * Why: Allow and block rules checked before any other logic; active rules are cached in Redis (scenario ip-rules).
 */
export const ipRules = pgTable(
  'ip_rules',
  {
    id: pk(),
    kind: text().$type<IpRuleKind>().notNull(),
    scope: text().$type<IpRuleScope>().notNull(),
    /** a single address reads back with /32 (/128 for IPv6) */
    cidr: cidr().notNull(),
    label: text().notNull().default(''),
    reason: text().notNull().default(''),
    source: text().$type<IpRuleSource>().notNull().default('manual'),
    expiresAt: timestampTz(),
    hitCount: integer().notNull().default(0),
    lastHitAt: timestampTz(),
    /** null for rules created by the risk engine */
    createdBy: fk((): AnyPgColumn => staffUsers.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('ip_rules_kind_check', inList(t.kind, IP_RULE_KINDS)),
    check('ip_rules_scope_check', inList(t.scope, IP_RULE_SCOPES)),
    check('ip_rules_source_check', inList(t.source, IP_RULE_SOURCES)),
    index('ip_rules_kind_created_idx').on(t.kind, t.createdAt.desc()),
    index('ip_rules_created_by_idx').on(t.createdBy),
  ],
);

/** A row read from `ip_rules`. */
export type IpRule = typeof ipRules.$inferSelect;

/** A row to insert into `ip_rules`. */
export type NewIpRule = typeof ipRules.$inferInsert;
