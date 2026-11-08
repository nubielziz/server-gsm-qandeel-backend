// Unit tests of the mail drivers (feature 12a, decision 033): the SMTP options with their timeouts, what a nodemailer failure means (permanent or not,
// no address in the reason), the SMTP driver with a fake transporter, and the in-memory driver the tests use.
import { describe, expect, it } from 'bun:test';
import { expectRejection, rejectionOf } from '../../../../test/support/rejection';
import { DeliveryError } from './delivery-error';
import {
  InMemoryMailDriver,
  type MailTransporter,
  SmtpMailDriver,
  classifyMailError,
  smtpOptions,
} from './mail-driver';

const MAIL = {
  from: 'GSM <noreply@gsm.local>',
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
});

describe('classifyMailError', () => {
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
