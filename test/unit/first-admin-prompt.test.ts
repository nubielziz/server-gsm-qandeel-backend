// Unit tests of the first-admin questions (P4b round 2) with a fake prompter, so no terminal is needed: yes / Enter / n, each bad
// answer asked again, three bad tries ending the run, and a cancel at every question.
import { describe, expect, it } from 'bun:test';
import { type Prompter, askFirstAdmin } from '../../scripts/lib/first-admin-prompt';

/** One scripted answer: the text, or `null` for a cancel (Ctrl+C, Ctrl+D, end of input). */
type Reply = string | null;

/** A prompter that answers from a script and records every question, so a test can see which questions were asked. */
function scripted(replies: Reply[]) {
  const questions: string[] = [];
  const secret: boolean[] = [];
  const next = (question: string, hidden: boolean): Promise<string | null> => {
    questions.push(question.trim());
    secret.push(hidden);
    if (replies.length === 0) throw new Error(`The script ran out of answers at "${question.trim()}".`);
    return Promise.resolve(replies.shift()!);
  };
  const prompter: Prompter = {
    ask: (question) => next(question, false),
    askHidden: (question) => next(question, true),
  };
  return { prompter, questions, secret, left: () => replies.length };
}

const GOOD_PASSWORD = 'a-long-passphrase-4U';
const TAKEN = new Set(['taken@example.com']);

async function run(replies: Reply[]) {
  const script = scripted(replies);
  const said: string[] = [];
  const answer = await askFirstAdmin({
    prompter: script.prompter,
    emailInUse: (email) => Promise.resolve(TAKEN.has(email)),
    say: (line) => said.push(line),
  });
  return { answer, said, ...script };
}

describe('askFirstAdmin: the happy path', () => {
  it('asks the five questions in order and returns the cleaned account', async () => {
    const { answer, questions, secret, said } = await run([
      '',
      '  Layla@Example.COM ',
      ' Layla    Haddad ',
      GOOD_PASSWORD,
      GOOD_PASSWORD,
    ]);
    expect(answer).toEqual({
      status: 'answered',
      owner: { email: 'layla@example.com', name: 'Layla Haddad', password: GOOD_PASSWORD },
    });
    expect(questions).toEqual([
      'No admin account yet. Create the first one now? [Y/n]',
      'Email:',
      'Full name:',
      'Password:',
      'Repeat password:',
    ]);
    // Only the two password questions are hidden.
    expect(secret).toEqual([false, false, false, true, true]);
    expect(said).toEqual([]);
  });

  it('treats Enter, y, Y and yes as yes', async () => {
    for (const yes of ['', 'y', 'Y', ' yes ', 'YES']) {
      const { answer } = await run([yes, 'a@b.co', 'Layla Haddad', GOOD_PASSWORD, GOOD_PASSWORD]);
      expect(answer.status).toBe('answered');
    }
  });

  it('ends at n and no, asking nothing more', async () => {
    for (const no of ['n', 'N', ' no ', 'NO']) {
      const { answer, questions } = await run([no]);
      expect(answer).toEqual({ status: 'declined' });
      expect(questions).toHaveLength(1);
    }
  });

  it('asks the yes/no question again for any other answer', async () => {
    const { answer, said, questions } = await run([
      'maybe',
      '',
      'a@b.co',
      'Layla Haddad',
      GOOD_PASSWORD,
      GOOD_PASSWORD,
    ]);
    expect(answer.status).toBe('answered');
    expect(said).toEqual(['  ✗ Answer y or n.']);
    expect(questions.slice(0, 2)).toEqual(Array(2).fill('No admin account yet. Create the first one now? [Y/n]'));
  });
});

describe('askFirstAdmin: a bad answer prints the rule and asks the same question again', () => {
  it('a bad email', async () => {
    const { answer, said, questions } = await run(['', 'nope', 'a@b.co', 'Layla Haddad', GOOD_PASSWORD, GOOD_PASSWORD]);
    expect(answer.status).toBe('answered');
    expect(said).toEqual(['  ✗ Enter a valid email address.']);
    expect(questions.filter((q) => q === 'Email:')).toHaveLength(2);
  });

  it('a taken email, refused at its own prompt before any password is asked', async () => {
    const { answer, said, questions } = await run([
      '',
      'Taken@Example.com',
      'free@example.com',
      'Layla Haddad',
      GOOD_PASSWORD,
      GOOD_PASSWORD,
    ]);
    expect(answer).toMatchObject({ status: 'answered', owner: { email: 'free@example.com' } });
    expect(said).toEqual(['  ✗ This email address already belongs to another staff member.']);
    // The taken email was refused at the second question; the password questions come after the email was accepted.
    expect(questions.indexOf('Password:')).toBeGreaterThan(questions.lastIndexOf('Email:'));
  });

  it('a bad name', async () => {
    const { answer, said } = await run(['', 'a@b.co', 'L', 'Layla Haddad', GOOD_PASSWORD, GOOD_PASSWORD]);
    expect(answer.status).toBe('answered');
    expect(said).toEqual(['  ✗ Enter a name.']);
  });

  it('a weak password, and one that holds the name, asked again without asking for the repeat', async () => {
    const { answer, said, questions } = await run([
      '',
      'layla@example.com',
      'Layla Haddad',
      'short',
      'haddad-and-more-9',
      GOOD_PASSWORD,
      GOOD_PASSWORD,
    ]);
    expect(answer.status).toBe('answered');
    expect(said).toEqual(['  ✗ Use at least 10 characters.', '  ✗ Do not use your name in your password.']);
    // No repeat was asked for a password that was already refused: three Password questions, one Repeat.
    expect(questions.filter((q) => q === 'Password:')).toHaveLength(3);
    expect(questions.filter((q) => q === 'Repeat password:')).toHaveLength(1);
  });

  it('a password that holds the email', async () => {
    const { answer, said } = await run([
      '',
      'layla@example.com',
      'Layla Haddad',
      'my-layla-secret-9',
      GOOD_PASSWORD,
      GOOD_PASSWORD,
    ]);
    expect(answer.status).toBe('answered');
    expect(said).toEqual(['  ✗ Do not use your email address in your password.']);
  });

  it('a repeat that differs asks for the password again', async () => {
    const { answer, said, questions } = await run([
      '',
      'a@b.co',
      'Layla Haddad',
      GOOD_PASSWORD,
      'another-passphrase-7K',
      GOOD_PASSWORD,
      GOOD_PASSWORD,
    ]);
    expect(answer).toMatchObject({ status: 'answered', owner: { password: GOOD_PASSWORD } });
    expect(said).toEqual(['  ✗ The two passwords are not the same.']);
    expect(questions.slice(-4)).toEqual(['Password:', 'Repeat password:', 'Password:', 'Repeat password:']);
  });

  it('a question that is answered well on the third try still succeeds', async () => {
    const { answer } = await run(['', 'x', 'y', 'a@b.co', 'Layla Haddad', GOOD_PASSWORD, GOOD_PASSWORD]);
    expect(answer.status).toBe('answered');
  });
});

describe('askFirstAdmin: three bad tries end the questions', () => {
  it('on the yes/no question', async () => {
    const { answer, questions, left } = await run(['what', 'eh', 'hm', 'never-asked']);
    expect(answer).toEqual({ status: 'gave_up', question: 'Create the first one now?' });
    expect(questions).toHaveLength(3);
    expect(left()).toBe(1);
  });

  it('on the email, including a taken one, without asking for a name', async () => {
    const { answer, questions, said } = await run(['', 'nope', 'taken@example.com', 'still bad']);
    expect(answer).toEqual({ status: 'gave_up', question: 'Email' });
    expect(questions).not.toContain('Full name:');
    expect(said).toHaveLength(3);
  });

  it('on the name', async () => {
    const { answer, questions } = await run(['', 'a@b.co', 'L', ' ', 'M']);
    expect(answer).toEqual({ status: 'gave_up', question: 'Full name' });
    expect(questions).not.toContain('Password:');
  });

  it('on the password: weak, then a repeat that differs, then weak again', async () => {
    const { answer, questions } = await run([
      '',
      'a@b.co',
      'Layla Haddad',
      'short',
      GOOD_PASSWORD,
      'another-passphrase-7K',
      'tiny',
    ]);
    expect(answer).toEqual({ status: 'gave_up', question: 'Password' });
    expect(questions.filter((q) => q === 'Password:')).toHaveLength(3);
  });

  it('on a repeat that differs three times', async () => {
    const pair = [GOOD_PASSWORD, 'another-passphrase-7K'];
    const { answer } = await run(['', 'a@b.co', 'Layla Haddad', ...pair, ...pair, ...pair]);
    expect(answer).toEqual({ status: 'gave_up', question: 'Password' });
  });
});

describe('askFirstAdmin: Ctrl+C or the end of the input at any question cancels', () => {
  const upTo = (n: number): Reply[] => ['', 'a@b.co', 'Layla Haddad', GOOD_PASSWORD, GOOD_PASSWORD].slice(0, n);

  for (const [index, question] of [
    'the yes/no question',
    'the email',
    'the full name',
    'the password',
    'the repeat',
  ].entries()) {
    it(`at ${question}`, async () => {
      const { answer, questions } = await run([...upTo(index), null]);
      expect(answer).toEqual({ status: 'cancelled' });
      // Nothing after the cancelled question was asked.
      expect(questions).toHaveLength(index + 1);
    });
  }

  it('after a bad answer too (the second try is cancelled)', async () => {
    const { answer } = await run(['', 'nope', null]);
    expect(answer).toEqual({ status: 'cancelled' });
  });
});

describe('askFirstAdmin: secrets', () => {
  it('never prints a password it was given, in a rule or anywhere else', async () => {
    const secrets = ['haddad-and-more-9', GOOD_PASSWORD, 'another-passphrase-7K'];
    const { answer, said } = await run([
      '',
      'a@b.co',
      'Layla Haddad',
      'haddad-and-more-9', // refused: holds the name
      GOOD_PASSWORD,
      'another-passphrase-7K', // refused: the repeat differs
      GOOD_PASSWORD,
      GOOD_PASSWORD,
    ]);
    expect(answer.status).toBe('answered');
    expect(said).toHaveLength(2);
    for (const line of said) for (const secret of secrets) expect(line).not.toContain(secret);
  });
});
