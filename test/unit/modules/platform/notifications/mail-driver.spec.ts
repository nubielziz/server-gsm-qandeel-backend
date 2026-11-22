// Unit tests of the mail drivers (feature 12a, decision 033): the SMTP options with their timeouts, what a nodemailer failure means (permanent or not,
// no address in the reason), the SMTP driver with a fake transporter, and the in-memory driver the tests use.
import { describe, expect, it } from 'bun:test';
import { expectRejection, rejectionOf } from '../../../../support/rejection';
import { DeliveryError } from '@src/modules/platform/notifications/delivery-error';
import {
  InMemoryMailDriver,
  type MailTransporter,
  SmtpMailDriver,
  classifyMailError,
  smtpOptions,
} from '@src/modules/platform/notifications/mail-driver';

const MAIL = {
  from: 'IMEI-HUB <noreply@gsm.local>',
  to: 'ops@zainmobilehub.example',
  subject: 'Hello',
  text: 'Hi',
  messageId: '<notification-1@gsm.local>',
};

describe('smtpOptions', () => {
  it('reads host, port, TLS mode and credentials from the URL, and always sets timeouts', () => {
    expect(smtpOptions('smtp://localhost:1025')).toMatchObject({
      host: 'localhost',
      port: 1025,
      secure: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    expect(smtpOptions('smtp://localhost:1025')).not.toHaveProperty('auth');
    expect(smtpOptions('smtps://mailer%40gsm:p%40ss@smtp.example.com')).toMatchObject({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'mailer@gsm', pass: 'p@ss' },
    });
    expect(smtpOptions('smtp://relay.example.com')).toMatchObject({ port: 587, secure: false });
  });

  it('requires STARTTLS on smtp:// when asked, and leaves smtps:// as TLS from the start (decision 055)', () => {
    expect(smtpOptions('smtp://relay.example.com:587', { requireTls: true })).toMatchObject({
      secure: false,
      requireTLS: true,
    });
    const implicit = smtpOptions('smtps://relay.example.com', { requireTls: true });
    expect(implicit).toMatchObject({ secure: true });
    expect(implicit).not.toHaveProperty('requireTLS');
    // Without the option (development: the mail catcher speaks plain text) nothing changes.
    expect(smtpOptions('smtp://localhost:1025')).not.toHaveProperty('requireTLS');
    expect(smtpOptions('smtp://localhost:1025', { requireTls: false })).not.toHaveProperty('requireTLS');
  });
});

describe('classifyMailError', () => {
  it('stores a refusal without the addresses, links and token-like strings it quotes (decision 054)', () => {
    const error = classifyMailError({
      responseCode: 550,
      response: '550 5.7.1 rejected https://shop.example.com/sign-in?token=AbCdEfGhIjKlMnOpQrStUvWx for r@x.io',
    });
    expect(error.message).toBe('550 5.7.1 rejected [link] for r***@x.io');
    expect(error.message).not.toContain('AbCdEfGhIjKlMnOpQrStUvWx');
  });

  it('treats an SMTP 5xx answer and a refused envelope as permanent, and 4xx, timeouts and drops as worth a retry', () => {
    expect(classifyMailError({ responseCode: 550, response: '550 5.1.1 No such user' }).permanent).toBe(true);
    expect(classifyMailError({ code: 'EENVELOPE', message: 'No recipients defined' }).permanent).toBe(true);
    expect(classifyMailError({ code: 'EMESSAGE', message: 'bad message' }).permanent).toBe(true);
    expect(classifyMailError({ responseCode: 451, response: '451 Try again later' }).permanent).toBe(false);
    expect(classifyMailError({ code: 'ETIMEDOUT', message: 'Connection timeout' }).permanent).toBe(false);
    expect(classifyMailError({ code: 'ECONNECTION', message: 'read ECONNRESET' }).permanent).toBe(false);
    expect(classifyMailError(new Error('boom')).permanent).toBe(false);
    expect(classifyMailError(undefined).message).toBe('The mail server refused the message.');
  });

  it('decides a refused envelope or message by the server answer when there is one (nodemailer codes 4xx answers EENVELOPE too)', () => {
    // A provider's rate limit or a busy server at MAIL FROM, RCPT TO or DATA: retried, never lost on the first attempt.
    expect(
      classifyMailError({ code: 'EENVELOPE', responseCode: 451, response: '451 4.7.1 Too many requests' }).permanent,
    ).toBe(false);
    expect(
      classifyMailError({ code: 'EENVELOPE', responseCode: 421, response: '421 Service not available' }).permanent,
    ).toBe(false);
    expect(
      classifyMailError({ code: 'EMESSAGE', responseCode: 452, response: '452 Insufficient storage' }).permanent,
    ).toBe(false);
    // A sender on a domain the provider has not verified will not change on a retry.
    expect(
      classifyMailError({
        code: 'EENVELOPE',
        responseCode: 550,
        response: '550 The example.com domain is not verified.',
      }).permanent,
    ).toBe(true);
    expect(classifyMailError({ code: 'EMESSAGE', responseCode: 554, response: '554 Message rejected' }).permanent).toBe(
      true,
    );
  });

  it('retries a refused login: a wrong or rotated key is the configuration, not the message', () => {
    expect(
      classifyMailError({ code: 'EAUTH', responseCode: 535, response: '535 Authentication credentials invalid' })
        .permanent,
    ).toBe(false);
    expect(classifyMailError({ code: 'EAUTH', message: 'Missing credentials for "PLAIN"' }).permanent).toBe(false);
    expect(classifyMailError({ responseCode: 530, response: '530 Authentication required' }).permanent).toBe(false);
  });

  it('never keeps a full address in the reason, and keeps it short', () => {
    const error = classifyMailError({
      responseCode: 550,
      response:
        '550 5.1.1 <ops@zainmobilehub.example>: Recipient address rejected: User unknown in virtual mailbox table',
    });
    expect(error).toBeInstanceOf(DeliveryError);
    expect(error.message).not.toContain('ops@zainmobilehub.example');
    expect(error.message).toContain('o***@zainmobilehub.example');
    expect(classifyMailError({ message: 'x'.repeat(1000) }).message.length).toBeLessThanOrEqual(300);
  });
});

describe('SmtpMailDriver', () => {
  function fake() {
    const calls: Array<Record<string, unknown>> = [];
    const made: Array<Record<string, unknown>> = [];
    let failure: Error | undefined;
    let closed = 0;
    const transporter: MailTransporter = {
      sendMail: (mail) => {
        if (failure) return Promise.reject(failure);
        calls.push(mail);
        return Promise.resolve({});
      },
      verify: () => (failure ? Promise.reject(failure) : Promise.resolve(true)),
      close: () => {
        closed += 1;
      },
    };
    return {
      calls,
      made,
      get closed() {
        return closed;
      },
      fail: (error: { message?: string; [key: string]: unknown } | undefined) => {
        failure = error ? Object.assign(new Error(error.message ?? 'failed'), error) : undefined;
      },
      factory: (options: Record<string, unknown>) => {
        made.push(options);
        return transporter;
      },
    };
  }

  it('connects on first use only, sends the text part always and the HTML part when there is one', async () => {
    const rig = fake();
    const driver = new SmtpMailDriver('smtp://localhost:1025', rig.factory);
    expect(rig.made).toEqual([]);
    await driver.send(MAIL);
    await driver.send({ ...MAIL, html: '<p>Hi</p>' });
    expect(rig.made).toHaveLength(1);
    expect(rig.calls[0]).toEqual({
      from: MAIL.from,
      to: MAIL.to,
      subject: 'Hello',
      text: 'Hi',
      messageId: MAIL.messageId,
    });
    expect(rig.calls[1]).toMatchObject({ html: '<p>Hi</p>', text: 'Hi' });
  });

  it('passes the TLS requirement through to the transporter it makes (decision 055)', async () => {
    const rig = fake();
    const driver = new SmtpMailDriver('smtp://relay.example.com:587', rig.factory, { requireTls: true });
    await driver.send(MAIL);
    expect(rig.made[0]).toMatchObject({ secure: false, requireTLS: true });
    const plain = fake();
    await new SmtpMailDriver('smtp://relay.example.com:587', plain.factory).send(MAIL);
    expect(plain.made[0]).not.toHaveProperty('requireTLS');
  });

  it('turns a transporter failure into a DeliveryError that says whether to retry, and verifies and closes', async () => {
    const rig = fake();
    const driver = new SmtpMailDriver('smtp://localhost:1025', rig.factory);
    rig.fail({ responseCode: 550, response: '550 No such user' });
    expect(await rejectionOf(driver.send(MAIL))).toMatchObject({ name: 'DeliveryError', permanent: true });
    rig.fail({ code: 'ETIMEDOUT', message: 'timeout' });
    expect(await rejectionOf(driver.send(MAIL))).toMatchObject({ name: 'DeliveryError', permanent: false });
    expect(await rejectionOf(driver.verify())).toMatchObject({ code: 'ETIMEDOUT' });
    rig.fail(undefined);
    expect(await driver.verify()).toBeUndefined();
    driver.close();
    expect(rig.closed).toBe(1);
    await driver.send(MAIL);
    expect(rig.made).toHaveLength(2);
  });
});

describe('InMemoryMailDriver', () => {
  it('records messages, fails on demand once, and answers verify from a switch', async () => {
    const driver = new InMemoryMailDriver();
    await driver.send({ ...MAIL });
    expect(driver.sent).toHaveLength(1);
    driver.failNext(new DeliveryError('busy'));
    await expectRejection(driver.send({ ...MAIL }), 'busy');
    await driver.send({ ...MAIL });
    expect(driver.sent).toHaveLength(2);
    driver.verifyError = new Error('no server');
    await expectRejection(driver.verify(), 'no server');
    driver.reset();
    expect(driver.sent).toEqual([]);
    expect(await driver.verify()).toBeUndefined();
  });
});
