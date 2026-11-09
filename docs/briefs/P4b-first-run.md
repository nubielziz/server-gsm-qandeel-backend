# P4b — first run on a fresh server, and a fresh start in development

Phase 4. Today only the development seed (`bun run db:seed`, which refuses production) creates what a working system needs before
its first use: the base currency, the system ledger accounts, the Owner role and a staff member who can sign in. A fresh production
database after `bun run db:migrate` therefore has no way in and cannot move money. This feature adds the production-safe first run
and a one-command fresh start for development. No new route.

## Items

1. **`bun run setup`** (`scripts/setup.ts`; allowed in production; idempotent; one transaction): creates what is missing and says
   what already existed.
   - The base currency USD (rate 1, active) and the 12 system ledger accounts of decision 024, exactly the rows the dev seed creates
     today. Move that definition into one place both use (the seed then calls it), so they can never drift.
   - The Owner role (permissions `['*']`, the seed's name and description) when no role grants every permission.
   - The first owner, only with `--email <address> --name "<full name>"`, and only when no staff member holds a role that grants every
     permission (otherwise it refuses and says to add staff from the console, Admins & access). The account is made the way
     `POST /admin/staff` makes one in its `temporary_password` mode: a strong generated temporary password, stored only as its hash,
     a password change forced at the first sign-in, printed once on stdout and nowhere else (never logged). The first sign-in then
     asks for TOTP enrollment like any new staff member (decision 018: two factors are mandatory).
   - One audit row per created thing, actor the system, in the demo's verb phrases the staff routes already use.
   - Validates its arguments (email, name) with the same rules as the staff routes; a clear message and exit code 1 on bad input.
2. **`bun run db:reset`** (`scripts/db-reset.ts`; development only, refused under `NODE_ENV=production` or a production configuration,
   like the seed; refused unless the database host is local): drops and recreates the database of `DATABASE_URL`, runs the
   migrations, empties the two Redis databases of the configuration (queue and cache: no stale jobs pointing at old ids) and the
   files bucket, then: nothing (`bun run db:reset`), the demo data (`--seed`), or the first run (`--setup --email ... --name ...`).
   It prints what it removed. Never touches the test databases.
3. **Docs**: README sections "First run on a server" (migrate, `setup`, sign in with the printed password, choose a new one, scan the
   TOTP code; then currencies, tax rates, gateways, suppliers and services from the console; the IP allow-list is optional and off) and
   "Start fresh in development" (`db:reset` and its flags); `.env.example` unchanged unless a new variable is needed (avoid one).

## Round 2 (added 2026-11-09, after the first build): the first admin from a prompt, and a test that fails at night

The owner of the project chose this flow for a fresh database (it must look like this transcript; wording may be tightened):

```
$ bun run setup
✓ Migrations: up to date
✓ Base currency USD: created
✓ 12 system ledger accounts: created
✓ Owner role: created

No admin account yet. Create the first one now? [Y/n] y
  Email: you@example.com
  Full name: Saifi
  Password: ********
  Repeat password: ********
✓ First admin created: you@example.com
  Sign in at the console; you will set up 2FA (TOTP) first.
```

4. **`bun run setup` is the one command of the first run.**
   - It applies the pending migrations first (the same `migrateDatabase` as `bun run db:migrate`; harmless when there are none),
     then the reference data and the Owner role as in item 1, and prints one `✓` line per part (created / already there).
   - **Interactive first admin.** When no flag names an owner, stdin and stdout are both terminals, and no staff member holds a
     role that grants every permission, it asks `No admin account yet. Create the first one now? [Y/n]` (Enter means yes), then
     `Email`, `Full name`, `Password` and `Repeat password`. Each answer is checked as it is typed in, with the rules of item 1
     (the email and name rules of `POST /admin/staff`; the password with `checkPasswordPolicy`, which already refuses one that
     contains the person's email or name); a bad answer prints the rule and asks that question again (at most 3 tries, then
     exit 1 and nothing is created). An email that already belongs to another staff member is refused at its prompt. A repeat
     that differs asks for the password again. The password is never shown: one `*` per character, backspace works, and the
     terminal is always given back in its normal mode (also on Ctrl+C or an error). Ctrl+C or end of input at any prompt prints
     `Cancelled: no admin account was created.` and exits 130. Answering `n` finishes the run without an admin and says how to
     create one later (`bun run setup` again).
   - The person chose this password, so it is **not** temporary: stored only as the argon2id hash, no forced change at the first
     sign-in, and the first sign-in goes straight to the TOTP enrollment (decision 018 still holds: two factors are mandatory).
     The owner check runs again inside the transaction that creates the account, under the advisory lock: an owner made by
     someone else while the prompts were open makes the run refuse, with nothing created. Never put the password or its hash in
     an audit row, a log line or an error message.
   - **Scripted first admin** (no terminal, for a deploy script): `--email` and `--name` keep item 1's temporary password, printed
     once, with the forced change. New `--password-stdin` (only with `--email` and `--name`) reads the password from standard
     input instead (one line, the trailing newline removed), checks it with the same policy, and stores it like a chosen one.
   - No terminal and no flag: no question; the run ends with the line that says how to create the first admin.
5. **`bun run db:reset --setup`** without `--email`/`--name` runs the same interactive first run when stdin and stdout are terminals.
   Without a terminal it is refused **before anything is dropped** (`--setup needs a terminal to ask for the first admin, or pass
   --email and --name`). `--password-stdin` works there as in item 4.
6. **The night-time failure of `test/integration/dashboard.test.ts`** ("stats, queues and the age-only past-SLA rule", also on main):
   the test places orders relative to the test clock's *current real time*; after 21:00 UTC the order completed `3 days - 3 hours`
   ago lands on the same UTC day as the one of `2 days - 1 hour` (the daily revenue of `day(2)` doubles), and before 05:00 UTC the
   order created 5 hours ago falls on the previous day (`ordersByType.daily.at(-1)`). Pin that test's clock to 12:00 UTC of the
   current day (`clock.set(...)`; the `TestClock` is injected into the app), check the rest of the file and the other integration
   tests for the same day-boundary pattern (orders placed relative to the clock and then read per UTC day), fix what has it, and
   prove it: run the test with the clock at 23:30 UTC and at 02:00 UTC before and after the fix.
7. **Docs**: README "First run on a server" becomes: `bun run setup` in a terminal and answer the questions; then sign in, scan
   the TOTP code. The scripted form (`--email --name`, `--password-stdin`) for deploy scripts. "Start fresh in development":
   `bun run db:reset --setup` asks the same questions. `SETUP_USAGE` and `RESET_USAGE` follow.

## Tests

- `setup` on an empty test database: USD, the 12 accounts, the Owner role, the owner with a forced password change; a second run
  creates nothing; a second owner is refused while one exists; bad arguments refused.
- The printed temporary password signs in through the real routes (`POST /admin/auth/login`), the answer asks for the password change,
  then the 2FA setup works, as for a staff member made with `POST /admin/staff`.
- The seed still creates the same currency and accounts (it now calls the shared definition): the existing seed tests stay green.
- `db:reset`'s guards: refuses a production configuration and a non-local host (unit tests of the guard; do not run the reset against the
  development database in tests).

Round 2 tests:

- The question flow with a fake prompter (no terminal): yes / Enter / `n`; a bad email, a taken email, a weak password, a password
  that holds the name, a repeat that differs, each asked again; 3 bad tries end with exit 1 and nothing created; Ctrl+C / end of
  input at each prompt creates nothing.
- The hidden reader with a fake terminal stream: characters echo as `*`, backspace removes one, Enter ends, Ctrl+C and Ctrl+D
  cancel, raw mode is switched off again in every case (also when the stream errors).
- A chosen password (prompt or `--password-stdin`) signs in through the real routes (`POST /admin/auth/login`) with `next:
  'totp_setup'` (no password step) and the TOTP setup completes; the audit row holds neither the password nor its hash.
- An owner created between the prompts and the insert makes the run refuse with nothing created.
- `setup` and `db:reset` refuse the interactive mode without a terminal as described; `db:reset --setup` without a terminal and
  without flags is refused before the drop (unit test of the plan).
- The dashboard test passes with the clock at 23:30 UTC and 02:00 UTC.

Lead change during round 2 (2026-11-09, approved by the project owner): the per-process test memory guard in `test/setup.ts`
(`GSM_TEST_MAX_RSS_MB`) defaults to 6000 MB instead of 4000. The batch that holds `test/integration/first-run.test.ts` already
peaked at 3.3 GB without it and went just over 4000 MB with it; the guard exists to stop runaways (13 GB in a minute), which it
still does. Do not treat this change as hiding a defect; do report a test that itself grows without bound.
