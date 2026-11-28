// Unit tests of MerchantLifecycleMails.passwordSet (decision 079, the re-review of the sign-up finish): the mail that tells an account its
// sign-up finish set a password is its own event, written for the account in the caller's transaction, and never the staff notice.
import { describe, expect, it } from 'bun:test';
import { MerchantLifecycleMails } from '@src/modules/identity/application/mail/merchant-lifecycle-mails';

function mails() {
  const enqueued: Record<string, unknown>[] = [];
  const notifications = {
    enqueue: (_work: unknown, input: Record<string, unknown>) => {
      enqueued.push(input);
      return Promise.resolve();
    },
  };
  return { enqueued, mails: new MerchantLifecycleMails(notifications as never, {} as never) };
}

describe('MerchantLifecycleMails.passwordSet', () => {
  it("queues customer.password_set for the account, with the name and the one sentence, and no `to` (the account's own address)", async () => {
    const { enqueued, mails: sender } = mails();
    await sender.passwordSet({ tx: {} } as never, { id: 5, name: ' Daniel Whitmore ' });
    expect(enqueued).toEqual([
      {
        event: 'customer.password_set',
        recipient: { type: 'account', id: 5 },
        channel: 'email',
        variables: {
          customerName: 'Daniel Whitmore',
          change: 'A password was set for your account just now, when its sign-up was finished.',
        },
      },
    ]);
  });

  it('greets an account without a name as "there"', async () => {
    const { enqueued, mails: sender } = mails();
    await sender.passwordSet({ tx: {} } as never, { id: 6, name: '  ' });
    expect(enqueued[0]).toMatchObject({ variables: { customerName: 'there' } });
  });

  it('has no "password_set" kind of the staff notice any more: a retail notice names only staff actions', async () => {
    const { mails: sender } = mails();
    let thrown: unknown;
    try {
      await sender.securityNotice(
        { tx: {} } as never,
        { id: 5, name: 'Daniel', rankKind: 'retail' },
        'api_key_created',
      );
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain('does not exist for a retail account');
  });
});
