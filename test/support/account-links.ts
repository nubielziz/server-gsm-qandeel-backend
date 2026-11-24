// The one-time links the app creates for accounts (sign-in links, invitations, password resets, email verification), recorded as they
// are issued. One list for every rank: the token service is one, and the mail of a link is chosen later by the rank.
import { spyOn } from 'bun:test';
import { onCommit } from '@src/infra/db';
import { AccountAuthTokens } from '@src/modules/identity';
import type { TestApp } from './app';

/** A link that was created for an account's email. */
export interface AccountLink {
  /** The mail it belongs to: `magic_link`, `password_reset`, `invited` or `email_verification`. */
  readonly kind: string;
  readonly accountId: number;
  readonly token: string;
}

const MAIL_KIND: Readonly<Record<string, string>> = {
  magic_link: 'magic_link',
  reset: 'password_reset',
  invite: 'invited',
  verify_email: 'email_verification',
};

const links: AccountLink[] = [];

/**
 * Starts recording the links the app creates (call it in `beforeEach`, and `mock.restore()` in `afterEach`).
 *
 * Why: the outbox carries ids only and the clear token of a mail is made later, inside the mail job, which rotates the token (decision
 * 033). The token the request makes is a placeholder nobody receives, but it works until the job rotates it, so a test that follows a link
 * without running the job takes the placeholder from the token service as it is issued. It does not depend on the log level, which one
 * process shares between test files. Calling it again in the same test only clears the list.
 *
 * @param t the running test app
 */
export function captureAccountLinks(t: TestApp): void {
  links.length = 0;
  const tokens = t.app.get(AccountAuthTokens);
  if ((tokens.issue as { mock?: unknown }).mock !== undefined) return;
  const issue = tokens.issue.bind(tokens);
  spyOn(tokens, 'issue').mockImplementation(async (work, input) => {
    const issued = await issue(work, input);
    // Recorded at the commit: a link of a run that is rolled back on purpose (an email that gets no mail) was never sent.
    onCommit(
      () =>
        void links.push({
          kind: MAIL_KIND[input.purpose] ?? input.purpose,
          accountId: input.accountId,
          token: issued.token,
        }),
    );
    return issued;
  });
}

/**
 * The links created since {@link captureAccountLinks}, oldest first.
 *
 * @returns a copy of the list
 */
export function accountLinks(): AccountLink[] {
  return [...links];
}
