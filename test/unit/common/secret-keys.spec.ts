// Unit tests of the one rule that names a secret (decisions 007, 019, 054): the audit snapshots, the settings route and every log line use it.
import { describe, expect, it } from 'bun:test';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { isSecretKey, keyWords } from '@src/common/secret-keys';
import * as schema from '@src/infra/db/schema';
import { ADMIN_ALLOWLIST_KEY } from '@src/modules/identity/security/ip-rules/ip-rule-cache';
import { ADJUST_APPROVAL_LIMIT_KEY } from '@src/modules/money/domain/wallet-rules';
import { B2B_VAT_RATE_KEY, INVOICE_DUE_DAYS_KEY } from '@src/modules/money/domain/invoice-rules';
import { LOW_BALANCE_THRESHOLD_KEY } from '@src/modules/money/domain/low-balance';
import { AUTO_CREDIT_DELAY_KEY } from '@src/modules/money/domain/payment-rules';
import { MAINTENANCE_KEY } from '@src/modules/platform/maintenance/maintenance-state';
import { LOOKUP_KEY_CHECK_SETTING } from '@src/modules/platform/settings/lookup-key-check';
import { EDITABLE_SETTINGS } from '@src/modules/platform/settings/settings-registry';
import { REQUIRE_3DS_KEY, RISK_RULES_KEY } from '@src/modules/risk/domain/risk-rules';
import { POLICY_KEYS } from '@src/modules/storefront/domain/policy-rules';

describe('isSecretKey', () => {
  it('flags names that end in a secret word, in camelCase, snake_case and kebab-case', () => {
    for (const key of [
      'password',
      'passwordHash',
      'password_hash',
      'newPassword',
      'totpSecretEnc',
      'totp_secret_enc',
      'secret',
      'webhookSecret',
      'token',
      'sessionToken',
      'tokenHash',
      'keyHash',
      'apiKey',
      'api_key',
      'privateKey',
      'signingKey',
      'authorization',
      'cookie',
      'credentials',
      'configEnc',
      'imeiEnc',
      'pepper',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('leaves ordinary names alone, including ones that merely mention a secret word', () => {
    for (const key of [
      'name',
      'email',
      'roleId',
      'status',
      'passwordChangedAt',
      'mustChangePassword',
      'twofaEnabled',
      'tokenExpiresAt',
      'prefix',
      'idempotencyKey',
      'keyName',
      'lastLoginIp',
      'permissions',
      'enc1',
      '',
    ]) {
      // mustChangePassword ends in a secret word; the value rule (booleans stay readable) keeps it, see redactForAudit.
      if (key === 'mustChangePassword') continue;
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});

describe('keyWords', () => {
  it('splits every case style into lower-case words', () => {
    expect(keyWords('secretAccessKey')).toEqual(['secret', 'access', 'key']);
    expect(keyWords('x-gsm-signature')).toEqual(['x', 'gsm', 'signature']);
    expect(keyWords('support.attachmentRetentionDays')).toEqual(['support', 'attachment', 'retention', 'days']);
    expect(keyWords('')).toEqual([]);
  });
});

describe('isSecretKey (decision 054)', () => {
  it('names every secret the shared rule must hide', () => {
    for (const key of [
      'apiaccesskey',
      'apikey',
      'apiKey',
      'otpauthUrl',
      'otpauth_url',
      'signature',
      'x-gsm-signature',
      'stripe-signature',
      'recoveryCodes',
      'sentryDsn',
      'secretAccessKey',
      'botToken',
      'passwordHash',
      'tokenEnc',
      'publicTokenHash',
      'proxy-authorization',
      'passphrase',
      'salt',
      'jwt',
      'encryptionKey',
      'webhookKey',
      'hmacKey',
      'backup_codes',
      // Their boolean values stay readable: the value rule of the audit and the log walk keeps flags.
      'hasPassword',
      'mustChangePassword',
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
  });

  it('leaves names that only mention a secret word alone', () => {
    for (const key of [
      'code',
      'tokenId',
      'accessKeyId',
      'apiKeyHint',
      'webhookSecretHint',
      'secretHint',
      'passwordChangedAt',
      'emailVerifiedAt',
      'signatureRequired',
      'idempotency-key',
      'chatId',
      'requestFingerprint',
      // Audit rows say how an account got its credential under this key ("invite link emailed"); `credentials` stays secret.
      'credential',
    ]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  it('every hash, encrypted, password, secret and token column of the schema is a secret name', () => {
    const missed: string[] = [];
    for (const value of Object.values(schema)) {
      if (typeof value !== 'object' || value === null || !(Symbol.for('drizzle:IsDrizzleTable') in value)) continue;
      const table = getTableConfig(value as PgTable);
      for (const column of table.columns) {
        // The schema is written in camelCase; the database names are its snake_case form (decision 027).
        const tsKey = column.name;
        const name = tsKey.replace(/([A-Z])/g, '_$1').toLowerCase();
        // A password column holds a secret; a password time (`password_changed_at`) or flag (`password_set_by_staff`) does not.
        const password = name.startsWith('password') && !name.endsWith('_at') && column.dataType !== 'boolean';
        const secretColumn = /_(hash|enc|secret|token)$/.test(name) || name === 'token' || password;
        if (secretColumn && !isSecretKey(tsKey)) missed.push(`${table.name}.${name}`);
      }
    }
    expect(missed).toEqual([]);
  });

  it('no settings key the code stores is a secret name, so the settings route lists them all', () => {
    const keys = [
      ...EDITABLE_SETTINGS.map((setting) => setting.key),
      ...POLICY_KEYS,
      ADMIN_ALLOWLIST_KEY,
      RISK_RULES_KEY,
      REQUIRE_3DS_KEY,
      MAINTENANCE_KEY,
      LOW_BALANCE_THRESHOLD_KEY,
      ADJUST_APPROVAL_LIMIT_KEY,
      B2B_VAT_RATE_KEY,
      INVOICE_DUE_DAYS_KEY,
      AUTO_CREDIT_DELAY_KEY,
      'autoRefundFailed',
    ];
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) expect(isSecretKey(key), key).toBe(false);
  });

  it('names the marker of the lookup-key check a secret, so no settings route lists it', () => {
    expect(isSecretKey(LOOKUP_KEY_CHECK_SETTING)).toBe(true);
  });
});
