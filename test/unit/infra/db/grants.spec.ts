// Unit tests of the reading of the application role from the two connection URLs (decision 055): the role and password, the case of
// one user, and every refusal; and of the SCRAM-SHA-256 verifier the role is created with, against the vector of RFC 7677. The grants
// themselves are tested against a real database in test/integration/infra/db-grants.test.ts.
import { describe, expect, it } from 'bun:test';
import { createHash, createHmac } from 'node:crypto';
import {
  APPEND_ONLY_TABLES,
  GRANTS_LOCK_KEY,
  GrantsRefusedError,
  applicationRoleOf,
  scramSha256Verifier,
} from '@src/infra/db';

const OWNER = 'postgres://gsm:owner-password@db.internal:5432/gsm';

describe('applicationRoleOf', () => {
  it('reads the role and the percent-decoded password of the application URL', () => {
    expect(applicationRoleOf('postgres://gsm_app:p%40ss%2Fword%3A1@db.internal:5432/gsm', OWNER)).toEqual({
      role: 'gsm_app',
      password: 'p@ss/word:1',
    });
    expect(applicationRoleOf('postgres://_svc_2:secret@db.internal:5432/gsm', OWNER)).toEqual({
      role: '_svc_2',
      password: 'secret',
    });
  });

  it('answers "same role" when both URLs name one user (development, the tests)', () => {
    expect(
      applicationRoleOf('postgres://gsm:gsm@localhost:5432/gsm', 'postgres://gsm:other@localhost:5432/gsm'),
    ).toEqual({
      sameRole: 'gsm',
    });
    // Also for a name that would not be acceptable as an application role: nothing is granted, so nothing needs quoting.
    expect(applicationRoleOf('postgres://Owner:x@h/gsm', 'postgres://Owner:y@h/gsm')).toEqual({ sameRole: 'Owner' });
  });

  it('refuses a role name outside lower-case letters, digits and "_" or longer than 63 characters', () => {
    for (const name of ['GsmApp', 'gsm.app', 'gsm-app', '1gsm', 'gsm app', 'a'.repeat(64)]) {
      const attempt = () =>
        applicationRoleOf(`postgres://${encodeURIComponent(name)}:secret@db.internal:5432/gsm`, OWNER);
      expect(attempt, name).toThrow(GrantsRefusedError);
      expect(attempt, name).toThrow(
        'DATABASE_URL must name a role of lower-case letters, digits and "_" (at most 63 characters).',
      );
    }
    expect(applicationRoleOf(`postgres://${'a'.repeat(63)}:secret@db.internal:5432/gsm`, OWNER)).toEqual({
      role: 'a'.repeat(63),
      password: 'secret',
    });
  });

  it('refuses a missing password', () => {
    expect(() => applicationRoleOf('postgres://gsm_app@db.internal:5432/gsm', OWNER)).toThrow(GrantsRefusedError);
    expect(() => applicationRoleOf('postgres://gsm_app:@db.internal:5432/gsm', OWNER)).toThrow(
      "DATABASE_URL must carry the application role's password.",
    );
  });

  it('refuses a URL that cannot be read, with the same error type', () => {
    expect(() => applicationRoleOf('not a url', OWNER)).toThrow(GrantsRefusedError);
    expect(() => applicationRoleOf('postgres://gsm_app:x@h/gsm', 'not a url')).toThrow(GrantsRefusedError);
  });
});

describe('APPEND_ONLY_TABLES', () => {
  it('names the ledger, the order timeline, the audit log and the three history tables of the one account type', () => {
    // Decision 064: the map of old merchant and customer numbers, the history of rank changes and the keys of the staff wallet
    // actions only ever receive new rows, like the ledger. The list is compared as a set: its order is not part of the rule.
    const tables: string[] = [...APPEND_ONLY_TABLES];
    expect(tables.sort()).toEqual(
      [
        'ledger_entries',
        'ledger_transactions',
        'order_events',
        'audit_logs',
        'account_legacy_ids',
        'account_rank_changes',
        'wallet_action_keys',
      ].sort(),
    );
  });

  it('lists no table twice', () => {
    const tables: string[] = [...APPEND_ONLY_TABLES];
    expect(new Set(tables).size).toBe(tables.length);
  });
});
describe('applicationRoleOf and the password', () => {
  it('accepts every printable ASCII character, a space included', () => {
    expect(applicationRoleOf('postgres://gsm_app:a%20b~!%23$%25%26*()%2B=@db.internal:5432/gsm', OWNER)).toEqual({
      role: 'gsm_app',
      password: 'a b~!#$%&*()+=',
    });
  });

  it('refuses a password with a character outside printable ASCII, without repeating it', () => {
    for (const encoded of ['caf%C3%A9', 'tab%09tab', 'nul%00x', 'del%7Fx', '%E2%82%AC']) {
      const attempt = () => applicationRoleOf(`postgres://gsm_app:${encoded}@db.internal:5432/gsm`, OWNER);
      expect(attempt, encoded).toThrow(GrantsRefusedError);
      expect(attempt, encoded).toThrow('printable ASCII');
      try {
        attempt();
      } catch (error) {
        expect((error as Error).message).not.toContain(decodeURIComponent(encoded));
      }
    }
  });
});

describe('scramSha256Verifier', () => {
  // RFC 7677 section 3: user "user", password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096 rounds.
  const SALT = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  const VERIFIER =
    'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=';

  it('builds the verifier of the published example, byte for byte', () => {
    expect(scramSha256Verifier('pencil', SALT)).toBe(VERIFIER);
  });

  it('checks out against the exchange of the RFC: the server signature and the client proof both verify', () => {
    const parts = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(scramSha256Verifier('pencil', SALT));
    const storedKey = Buffer.from(parts?.[3] ?? '', 'base64');
    const serverKey = Buffer.from(parts?.[4] ?? '', 'base64');
    const authMessage =
      'n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,' +
      'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    // v= of the server's final message
    expect(createHmac('sha256', serverKey).update(authMessage).digest('base64')).toBe(
      '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=',
    );
    // p= of the client's final message: proof = ClientKey xor HMAC(StoredKey, AuthMessage), and SHA-256(ClientKey) = StoredKey
    const signature = createHmac('sha256', storedKey).update(authMessage).digest();
    const proof = Buffer.from('dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=', 'base64');
    const clientKey = Buffer.from(proof.map((byte, index) => byte ^ (signature[index] ?? 0)));
    expect(createHash('sha256').update(clientKey).digest().equals(storedKey)).toBe(true);
  });

  it('takes a new random 16-byte salt every time and never contains the password', () => {
    const first = scramSha256Verifier('a-generated-secret-0123456789');
    const second = scramSha256Verifier('a-generated-secret-0123456789');
    expect(first).not.toBe(second);
    for (const verifier of [first, second]) {
      expect(verifier).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
      expect(verifier).not.toContain('a-generated-secret');
    }
  });

  it('refuses an empty password and one with a character outside printable ASCII', () => {
    for (const password of ['', 'caf\u00e9', 'tab\there', 'nul\u0000']) {
      expect(() => scramSha256Verifier(password), JSON.stringify(password)).toThrow(GrantsRefusedError);
    }
  });
});

describe('GRANTS_LOCK_KEY', () => {
  it('is a whole number the database takes as one bigint key', () => {
    expect(Number.isSafeInteger(GRANTS_LOCK_KEY)).toBe(true);
    expect(GRANTS_LOCK_KEY).toBeGreaterThan(0);
  });
});
