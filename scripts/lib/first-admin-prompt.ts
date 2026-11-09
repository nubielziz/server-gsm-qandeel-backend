// The questions of the first admin account (P4b round 2): "Create the first one now?", email, full name, password twice. Used by
// scripts/lib/first-run-flow.ts for `bun run setup` and `bun run db:reset --setup`. It knows no terminal: it talks to a `Prompter`.
import { type OwnerInput, judgeEmail, judgeName, judgePassword } from '../first-run';

/**
 * Asks one question and returns the answer.
 *
 * Why: the question flow is tested without a terminal by passing a fake; the real one (terminal-prompter.ts) reads the keyboard.
 * Both methods resolve to the typed text, or to `null` when the person cancelled (Ctrl+C, Ctrl+D, end of input).
 */
export interface Prompter {
  /** A plain question: the answer is shown while it is typed. */
  ask(question: string): Promise<string | null>;
  /** A secret question: the answer is never shown (one `*` per character). */
  askHidden(question: string): Promise<string | null>;
}

/** How many times one question may be answered badly before the run gives up. */
export const MAX_TRIES = 3;

/** How the questions ended. */
export type FirstAdminAnswer =
  /** All answers were good: the account to create (with the password the person chose). */
  | { readonly status: 'answered'; readonly owner: OwnerInput & { readonly password: string } }
  /** The person answered `n`. */
  | { readonly status: 'declined' }
  /** The person cancelled (Ctrl+C, Ctrl+D or the input ended). */
  | { readonly status: 'cancelled' }
  /** A question was answered badly {@link MAX_TRIES} times; `question` names it. */
  | { readonly status: 'gave_up'; readonly question: string };

/** What {@link askFirstAdmin} needs besides the questions. */
export interface FirstAdminPromptOptions {
  readonly prompter: Prompter;
  /** Tells whether another staff member already has this email (a read of the database). */
  readonly emailInUse: (email: string) => Promise<boolean>;
  /** Prints one line of feedback (the rule a bad answer broke). */
  readonly say: (line: string) => void;
}

/** The outcome of one try at one question: the good value, or the message that makes the question come again. */
type Judgement<T> = { readonly value: T } | { readonly retry: string };

/**
 * Asks one question until the answer is good, at most {@link MAX_TRIES} times.
 *
 * @returns the value, or `null` when the person cancelled, or `undefined` when every try was bad
 */
async function askUntilGood<T>(
  options: FirstAdminPromptOptions,
  ask: () => Promise<string | null>,
  judge: (answer: string) => Judgement<T> | Promise<Judgement<T>>,
): Promise<T | null | undefined> {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const answer = await ask();
    if (answer === null) return null;
    const judgement = await judge(answer);
    if ('value' in judgement) return judgement.value;
    options.say(`  ✗ ${judgement.retry}`);
  }
  return undefined;
}

/** Reads the answer to "[Y/n]": Enter, `y` and `yes` mean yes. */
function judgeYesNo(answer: string): Judgement<boolean> {
  const text = answer.trim().toLowerCase();
  if (text === '' || text === 'y' || text === 'yes') return { value: true };
  if (text === 'n' || text === 'no') return { value: false };
  return { retry: 'Answer y or n.' };
}

/**
 * Asks for the first admin account: whether to make it now, then email, full name, password and the password again.
 *
 * Why: P4b round 2. On a fresh database the person types the first admin's details instead of copying a generated password.
 * Each answer is judged as it is typed, with the rules of `POST /admin/staff` (email and name) and the staff password policy
 * (which refuses a password that holds the email or the name); a bad answer prints the rule and the question comes again, up to
 * {@link MAX_TRIES} times. A taken email is refused at its own question, before any password is asked. A repeat that differs asks
 * for the password again (the pair counts as one try). Nothing is written here: the caller creates the account.
 *
 * @param options the prompter, the email lookup and where to print feedback
 * @returns how the questions ended; the password is only in an `answered` result and nowhere else (never printed)
 */
export async function askFirstAdmin(options: FirstAdminPromptOptions): Promise<FirstAdminAnswer> {
  const { prompter } = options;

  const wanted = await askUntilGood(
    options,
    () => prompter.ask('No admin account yet. Create the first one now? [Y/n] '),
    judgeYesNo,
  );
  if (wanted === null) return { status: 'cancelled' };
  if (wanted === undefined) return { status: 'gave_up', question: 'Create the first one now?' };
  if (!wanted) return { status: 'declined' };

  const email = await askUntilGood(
    options,
    () => prompter.ask('  Email: '),
    async (answer): Promise<Judgement<string>> => {
      const checked = judgeEmail(answer);
      if ('problem' in checked) return { retry: checked.problem };
      if (await options.emailInUse(checked.value)) {
        return { retry: 'This email address already belongs to another staff member.' };
      }
      return { value: checked.value };
    },
  );
  if (email === null) return { status: 'cancelled' };
  if (email === undefined) return { status: 'gave_up', question: 'Email' };

  const name = await askUntilGood(
    options,
    () => prompter.ask('  Full name: '),
    (answer): Judgement<string> => {
      const checked = judgeName(answer);
      return 'problem' in checked ? { retry: checked.problem } : { value: checked.value };
    },
  );
  if (name === null) return { status: 'cancelled' };
  if (name === undefined) return { status: 'gave_up', question: 'Full name' };

  // The password and its repeat are one question: a repeat that differs asks for both again.
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const password = await prompter.askHidden('  Password: ');
    if (password === null) return { status: 'cancelled' };
    const problem = judgePassword(password, { email, name });
    if (problem !== undefined) {
      options.say(`  ✗ ${problem}`);
      continue;
    }
    const repeat = await prompter.askHidden('  Repeat password: ');
    if (repeat === null) return { status: 'cancelled' };
    if (repeat !== password) {
      options.say('  ✗ The two passwords are not the same.');
      continue;
    }
    return { status: 'answered', owner: { email, name, password } };
  }
  return { status: 'gave_up', question: 'Password' };
}
