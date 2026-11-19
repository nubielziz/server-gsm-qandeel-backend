// Unit tests of the arguments of `bun run setup` (P4b): the options, the staff rules applied to the first owner and its password,
// and the lines the run prints.
import { describe, expect, it } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import {
  FirstRunError,
  SETUP_USAGE,
  type FirstRunReport,
  NO_ADMIN_HINT,
  checkOwnerInput,
  describeFailure,
  describeFirstAdmin,
  describeReferenceData,
  judgeEmail,
  judgeName,
  judgePassword,
  parseSetupArgs,
} from '../../scripts/first-run';
import { parseResetArgs } from '../../scripts/lib/db-reset-plan';
import { passwordFromStdinText } from '../../scripts/lib/stdin-password';

describe('parseSetupArgs', () => {
  it('reads --email and --name in both spellings', () => {
    expect(parseSetupArgs(['--email', 'a@b.co', '--name', 'Layla Haddad'])).toEqual({
      email: 'a@b.co',
      name: 'Layla Haddad',
      passwordStdin: false,
      help: false,
    });
    expect(parseSetupArgs(['--name=Layla Haddad', '--email=a@b.co'])).toEqual({
      email: 'a@b.co',
      name: 'Layla Haddad',
      passwordStdin: false,
      help: false,
    });
  });

  it('reads --password-stdin, only together with --email and --name', () => {
    expect(parseSetupArgs(['--email', 'a@b.co', '--name', 'Layla Haddad', '--password-stdin'])).toEqual({
      email: 'a@b.co',
      name: 'Layla Haddad',
      passwordStdin: true,
      help: false,
    });
    for (const argv of [
      ['--password-stdin'],
      ['--password-stdin', '--email', 'a@b.co'],
      ['--name', 'Layla Haddad', '--password-stdin'],
    ]) {
      expect(() => parseSetupArgs(argv)).toThrow(/--password-stdin needs both --email and --name/);
    }
    expect(() =>
      parseSetupArgs(['--email', 'a@b.co', '--name', 'Layla Haddad', '--password-stdin', '--password-stdin']),
    ).toThrow(/--password-stdin was given twice/);
    expect(() => parseSetupArgs(['--password-stdin=secret'])).toThrow(/Unknown argument/);
  });

  it('reads nothing as nothing, and --help or -h as help', () => {
    expect(parseSetupArgs([])).toEqual({ passwordStdin: false, help: false });
    expect(parseSetupArgs(['--help']).help).toBe(true);
    expect(parseSetupArgs(['-h']).help).toBe(true);
  });

  it('refuses an unknown option, a missing value and a repeated option', () => {
    expect(() => parseSetupArgs(['--bogus'])).toThrow(FirstRunError);
    expect(() => parseSetupArgs(['--seed'])).toThrow(/Unknown argument "--seed"/);
    expect(() => parseSetupArgs(['--email'])).toThrow(/--email needs a value/);
    expect(() => parseSetupArgs(['--email', '--name', 'X Y'])).toThrow(/--email needs a value/);
    expect(() => parseSetupArgs(['--email', 'a@b.co', '--email', 'c@d.co'])).toThrow(/--email was given twice/);
  });
});

describe('parseSetupArgs: an unknown argument may hold a password', () => {
  const SECRET = 'Hunter2-secret-99';

  it('names the option but never repeats what follows "="', () => {
    for (const arg of [`--password=${SECRET}`, `--pass=${SECRET}`, `-p=${SECRET}`, `--seed=${SECRET}`]) {
      expect(() => parseSetupArgs([arg])).toThrow(FirstRunError);
      try {
        parseSetupArgs([arg]);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(SECRET);
        expect(message).toContain(`Unknown argument "${arg.split('=')[0]}"`);
      }
    }
  });

  it('points a password option to standard input', () => {
    expect(() => parseSetupArgs([`--password=${SECRET}`])).toThrow(/--password-stdin/);
    expect(() => parseSetupArgs([`--password=${SECRET}`])).toThrow(/Unknown argument "--password"\./);
  });

  it('does not repeat the value that follows the option, or a value with no option name', () => {
    for (const argv of [['--password', SECRET], [SECRET], ['--email', 'a@b.co', SECRET]]) {
      try {
        parseSetupArgs(argv);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(FirstRunError);
        expect((error as Error).message).not.toContain(SECRET);
      }
    }
    expect(() => parseSetupArgs([SECRET])).toThrow(/Unknown argument \(its text is not shown\)/);
  });

  it('keeps the usual message for an option that holds no secret', () => {
    expect(() => parseSetupArgs(['--bogus'])).toThrow(/Unknown argument "--bogus"\. Run with --help for the usage\./);
  });
});

describe('an unknown argument shows its text only when it is the name of an option', () => {
  const SECRET = 'Hunter2-secret-99';
  const hintOf = {
    setup: 'run `bun run setup` in a terminal',
    'db:reset': 'run `bun run db:reset --setup` in a terminal',
  };
  /** The two commands that read these options, each with a function that parses one argument and the hint it must name. */
  const commands = [
    { name: 'setup' as const, parse: (arg: string) => parseSetupArgs([arg], 'setup') },
    { name: 'db:reset' as const, parse: (arg: string) => parseResetArgs(['--setup', arg]) },
  ];
  /** `shown`: the text the message must quote; `undefined`: the message must say its text is not shown. `hint`: the password hint. */
  const cases: Array<{ arg: string; shown: string | undefined; hint: boolean }> = [
    { arg: `-p${SECRET}`, shown: undefined, hint: true },
    { arg: `-p=${SECRET}`, shown: '-p', hint: true },
    { arg: `--password=${SECRET}`, shown: '--password', hint: true },
    { arg: '-x', shown: '-x', hint: false },
    { arg: `-x=${SECRET}`, shown: '-x', hint: false },
    { arg: `-${SECRET}`, shown: undefined, hint: false },
    { arg: '---weird', shown: undefined, hint: false },
    { arg: `---${SECRET}`, shown: undefined, hint: false },
    { arg: '--', shown: undefined, hint: false },
    { arg: '-', shown: undefined, hint: false },
    { arg: SECRET, shown: undefined, hint: false },
  ];

  /** The message of the refusal that `parse` must throw. */
  function messageOf(parse: () => unknown, arg: string): string {
    try {
      parse();
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error(`expected a refusal of ${JSON.stringify(arg)}`);
  }

  for (const command of commands) {
    it(`never repeats a glued short option, a dash-led value or a bare word (${command.name})`, () => {
      for (const { arg, shown, hint } of cases) {
        const message = messageOf(() => command.parse(arg), arg);
        // The secret is in no message, whatever the case.
        expect(message).not.toContain(SECRET);
        if (shown === undefined) expect(message).toContain('Unknown argument (its text is not shown).');
        else expect(message).toContain(`Unknown argument "${shown}".`);
        if (hint) {
          expect(message).toContain('--password-stdin');
          expect(message).toContain(hintOf[command.name]);
        } else {
          expect(message).not.toContain('--password-stdin');
        }
      }
    });
  }
});

describe('SETUP_USAGE', () => {
  it('says the password is not printed (the check lines are)', () => {
    expect(SETUP_USAGE).toContain('it is not printed');
    expect(SETUP_USAGE).not.toContain('nothing is printed');
  });
});

describe('checkOwnerInput', () => {
  it('cleans the email like the staff routes: trimmed and lower-cased', () => {
    expect(checkOwnerInput({ email: '  Layla.Haddad@Example.COM ', name: 'Layla Haddad' })).toEqual({
      email: 'layla.haddad@example.com',
      name: 'Layla Haddad',
    });
  });

  it('collapses repeated spaces in the name, as the staff service does', () => {
    expect(checkOwnerInput({ email: 'a@b.co', name: '  Layla    Haddad ' })?.name).toBe('Layla Haddad');
  });

  it('wants both values or neither', () => {
    expect(checkOwnerInput({})).toBeUndefined();
    expect(() => checkOwnerInput({ email: 'a@b.co' })).toThrow(/Give both --email and --name/);
    expect(() => checkOwnerInput({ name: 'Layla Haddad' })).toThrow(/Give both --email and --name/);
  });

  it('refuses an email that is not an address, or longer than 254 characters', () => {
    for (const email of ['', 'layla', 'layla@', '@example.com', 'la yla@example.com', `${'a'.repeat(250)}@b.co`]) {
      expect(() => checkOwnerInput({ email, name: 'Layla Haddad' })).toThrow(/--email: /);
    }
  });

  it('judges the length of the name as typed, then collapses the spaces: the order of POST /admin/staff', () => {
    // 111 characters as typed, 11 once the spaces collapse: the route's contract (trim, 2 to 100) refuses it before the service collapses.
    const spread = `Layla${' '.repeat(100)}Haddad`;
    expect(judgeName(spread)).toEqual({ problem: 'Use at most 100 characters.' });
    expect(() => checkOwnerInput({ email: 'a@b.co', name: spread })).toThrow(/--name: Use at most 100/);
    // Exactly 100 characters is fine, and a double space inside is collapsed afterwards.
    expect(judgeName(`${'x'.repeat(48)}  ${'y'.repeat(50)}`)).toEqual({ value: `${'x'.repeat(48)} ${'y'.repeat(50)}` });
  });

  it('refuses a name shorter than 2 or longer than 100 characters', () => {
    expect(() => checkOwnerInput({ email: 'a@b.co', name: ' L ' })).toThrow(/--name: Enter a name\./);
    expect(() => checkOwnerInput({ email: 'a@b.co', name: 'x'.repeat(101) })).toThrow(/--name: Use at most 100/);
  });
});

describe('checkOwnerInput with a password', () => {
  const account = { email: 'layla@example.com', name: 'Layla Haddad' };

  it('keeps a password that follows the staff password policy', () => {
    expect(checkOwnerInput({ ...account, password: 'a-long-passphrase-4U' })).toEqual({
      ...account,
      password: 'a-long-passphrase-4U',
    });
  });

  it('refuses a weak password, or one that holds the email or the name, without repeating it', () => {
    for (const [password, message] of [
      ['short', /--password-stdin: Use at least 10 characters\./],
      ['password1234', /--password-stdin: This password is too easy to guess\./],
      ['my-layla-secret-9', /--password-stdin: Do not use your email address in your password\./],
      ['haddad-and-more-9', /--password-stdin: Do not use your name in your password\./],
    ] as const) {
      expect(() => checkOwnerInput({ ...account, password })).toThrow(message);
      try {
        checkOwnerInput({ ...account, password });
      } catch (error) {
        expect((error as Error).message).not.toContain(password);
      }
    }
  });

  it('refuses a password without an owner', () => {
    expect(() => checkOwnerInput({ password: 'a-long-passphrase-4U' })).toThrow(/needs --email and --name/);
  });
});

describe('judgeEmail, judgeName, judgePassword (the checks the prompt shares with the options)', () => {
  it('clean the value or name the rule', () => {
    expect(judgeEmail('  A@B.CO ')).toEqual({ value: 'a@b.co' });
    expect(judgeEmail('nope')).toEqual({ problem: 'Enter a valid email address.' });
    expect(judgeName('  Layla    Haddad ')).toEqual({ value: 'Layla Haddad' });
    expect(judgeName(' L ')).toEqual({ problem: 'Enter a name.' });
    const account = { email: 'layla@example.com', name: 'Layla Haddad' };
    expect(judgePassword('a-long-passphrase-4U', account)).toBeUndefined();
    expect(judgePassword('short', account)).toBe('Use at least 10 characters.');
  });
});

describe('passwordFromStdinText', () => {
  it('takes one line and drops its newline', () => {
    expect(passwordFromStdinText('a-long-passphrase-4U\n')).toBe('a-long-passphrase-4U');
    expect(passwordFromStdinText('a-long-passphrase-4U\r\n')).toBe('a-long-passphrase-4U');
    expect(passwordFromStdinText('a-long-passphrase-4U')).toBe('a-long-passphrase-4U');
  });

  it('keeps spaces inside and around the password', () => {
    expect(passwordFromStdinText('  spaced out pass  \n')).toBe('  spaced out pass  ');
  });

  it('refuses nothing, and more than one line, without repeating the text', () => {
    for (const text of ['', '\n', '\r\n']) expect(() => passwordFromStdinText(text)).toThrow(/no password was given/);
    expect(() => passwordFromStdinText('first-line-secret\nsecond\n')).toThrow(/must hold one line/);
    try {
      passwordFromStdinText('first-line-secret\nsecond\n');
    } catch (error) {
      expect((error as Error).message).not.toContain('secret');
    }
  });
});

describe('describeReferenceData', () => {
  const report = (over: Partial<FirstRunReport> = {}): FirstRunReport => ({
    currency: { code: 'USD', created: true },
    ledgerAccounts: { created: 12, existing: 0 },
    ownerRole: { id: 1, name: 'Owner', created: true },
    owners: 0,
    ...over,
  });

  it('writes one check line per part, as the approved transcript does', () => {
    expect(describeReferenceData(report())).toEqual([
      '✓ Base currency USD: created',
      '✓ 12 system ledger accounts: created',
      '✓ Owner role: created',
    ]);
  });

  it('says what was already there, also when only some accounts were', () => {
    expect(
      describeReferenceData(
        report({
          currency: { code: 'USD', created: false },
          ledgerAccounts: { created: 0, existing: 12 },
          ownerRole: { id: 3, name: 'Chief', created: false },
        }),
      ),
    ).toEqual([
      '✓ Base currency USD: already there',
      '✓ 12 system ledger accounts: already there',
      '✓ Owner role (Chief): already there',
    ]);
    expect(describeReferenceData(report({ ledgerAccounts: { created: 4, existing: 8 } }))[1]).toBe(
      '✓ 12 system ledger accounts: 4 created, 8 already there',
    );
  });
});

describe('describeFirstAdmin', () => {
  it('goes straight to the 2FA setup for a chosen password, and never prints a password', () => {
    const lines = describeFirstAdmin({ id: 1, name: 'Layla Haddad', email: 'a@b.co', onboarding: 'chosen_password' });
    expect(lines).toEqual([
      '✓ First admin created: a@b.co',
      '  Sign in at the console; you will set up 2FA (TOTP) first.',
    ]);
  });

  it('points to the temporary password for a generated one, without printing it', () => {
    const lines = describeFirstAdmin({
      id: 1,
      name: 'Layla Haddad',
      email: 'a@b.co',
      onboarding: 'temporary_password',
      temporaryPassword: 'SECRET-pass-123',
    });
    expect(lines.join('\n')).not.toContain('SECRET-pass-123');
    expect(lines.join('\n')).toContain('temporary password');
  });

  it('has a hint for a run that created no admin, naming the terminal and the options', () => {
    expect(NO_ADMIN_HINT).toContain('bun run setup');
    expect(NO_ADMIN_HINT).toContain('--email and --name');
    expect(NO_ADMIN_HINT).toContain('--password-stdin');
  });
});

describe('describeFailure', () => {
  it('prints the message of an error the operator can fix', () => {
    expect(describeFailure(new FirstRunError('An owner account already exists.'))).toBe(
      'An owner account already exists.',
    );
  });

  it('says to migrate when a table is missing (Postgres 42P01, wrapped by Drizzle)', () => {
    const wrapped = Object.assign(new Error('Failed query: select ...'), { cause: { code: '42P01' } });
    expect(describeFailure(wrapped)).toContain('bun run db:migrate');
  });

  it('gives the cause of a database error and never the failed query with its parameters (they hold the password hash)', () => {
    const wrapped = Object.assign(
      new Error('Failed query: insert into "staff_users" ... params: $argon2id$v=19$secret'),
      {
        cause: new Error('connection terminated unexpectedly'),
      },
    );
    expect(describeFailure(wrapped)).toBe('connection terminated unexpectedly');
  });

  it('keeps the password hash out of a query error with no cause, in the format Drizzle really writes', () => {
    // Drizzle writes `Failed query: <sql with $1 placeholders>\nparams: <values>`: the values, hash included, sit on line 2.
    const hash = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';
    const failed = new DrizzleQueryError(
      'insert into "staff_users" ("email", "password_hash") values ($1, $2)',
      ['a@b.co', hash],
      undefined,
    );
    expect(failed.message).toContain(hash);
    const text = describeFailure(failed);
    expect(text).not.toContain(hash);
    expect(text).not.toContain('argon2id');
    expect(text).not.toContain('params');
    expect(text).not.toContain('\n');
    // The same error with Postgres's own message as its cause: the cause is what the operator needs.
    const caused = new DrizzleQueryError(
      'insert ...',
      ['a@b.co', hash],
      new Error('connection terminated unexpectedly'),
    );
    expect(describeFailure(caused)).toBe('connection terminated unexpectedly');
  });
});
