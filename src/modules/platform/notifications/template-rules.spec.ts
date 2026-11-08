// Unit tests of the template rules (feature 12a): placeholders, validation, rendering, the HTML/text split.
import { describe, expect, it } from 'bun:test';
import {
  checkLocale,
  checkTemplateFields,
  escapeHtml,
  htmlToText,
  looksLikeHtml,
  placeholdersOf,
  renderMessage,
  renderSubject,
  renderText,
  unknownPlaceholders,
} from './template-rules';

describe('placeholders', () => {
  it('lists each placeholder once, tolerating spaces inside the braces', () => {
    expect(placeholdersOf('Hi {{customerName}}, {{ orderId }} / {{customerName}} {single} {{1bad}}')).toEqual([
      'customerName',
      'orderId',
    ]);
    expect(placeholdersOf('no marks')).toEqual([]);
  });

  it('names the ones an event does not offer', () => {
    expect(unknownPlaceholders('{{a}} {{b}} {{c}}', ['a'])).toEqual(['b', 'c']);
  });
});

describe('renderText', () => {
  it('fills known placeholders and leaves unknown ones as typed', () => {
    expect(renderText('Hi {{ customerName }}, {{typo}}', { customerName: 'Daniel' }, 'text')).toBe(
      'Hi Daniel, {{typo}}',
    );
  });

  it('escapes values in HTML and turns their line breaks into <br>, but never touches the template markup', () => {
    const html = renderText(
      '<p>Hi {{name}}</p><a href="{{link}}">x</a>',
      { name: '<b>"O\'Neil" & co</b>\nline', link: 'https://a.example/?x="1"' },
      'html',
    );
    expect(html).toBe(
      '<p>Hi &lt;b&gt;&quot;O&#39;Neil&quot; &amp; co&lt;/b&gt;<br>line</p><a href="https://a.example/?x=&quot;1&quot;">x</a>',
    );
    expect(html).not.toContain('<b>');
  });

  it('inserts values into plain text exactly as they are', () => {
    expect(renderText('{{v}}', { v: '<b>&</b>' }, 'text')).toBe('<b>&</b>');
  });
});

describe('renderSubject', () => {
  it('puts the subject on one line, so a value cannot add a header', () => {
    expect(renderSubject('Hello {{name}}', { name: 'Eve\r\nBcc: x@y.z' })).toBe('Hello Eve Bcc: x@y.z');
  });
});

describe('renderMessage', () => {
  it('makes an HTML email with a text part', () => {
    const message = renderMessage(
      {
        channel: 'email',
        subject: 'Order {{orderId}}',
        body: '<p>Hi {{name}}</p><p><a href="{{link}}">Open it</a></p>',
      },
      { orderId: '7', name: 'A&B', link: 'https://x.example/p?t=1&u=2' },
    );
    expect(message.format).toBe('html');
    expect(message.subject).toBe('Order 7');
    expect(message.html).toContain('Hi A&amp;B');
    expect(message.text).toBe('Hi A&B\nOpen it (https://x.example/p?t=1&u=2)');
  });

  it('keeps a plain email as text with no HTML part', () => {
    const message = renderMessage({ channel: 'email', subject: 'S', body: 'Hi {{name}}' }, { name: 'A' });
    expect(message).toEqual({ subject: 'S', text: 'Hi A', format: 'text' });
  });

  it('sends Telegram as plain text with no subject, cut at the Bot API limit', () => {
    const message = renderMessage({ channel: 'telegram', subject: 'ignored', body: 'x'.repeat(5000) }, {});
    expect(message.subject).toBe('');
    expect(message.text).toHaveLength(4096);
    expect(message.html).toBeUndefined();
  });
});

describe('htmlToText', () => {
  it('drops scripts and styles, keeps link addresses and decodes entities', () => {
    expect(
      htmlToText(
        '<style>p{}</style><script>alert(1)</script><p>5 &lt; 6 &amp; 7</p><br><a href="https://a.example">https://a.example</a>',
      ),
    ).toBe('5 < 6 & 7\n\nhttps://a.example');
  });
});

describe('looksLikeHtml and escapeHtml', () => {
  it('tells markup from text', () => {
    expect(looksLikeHtml('<p>hi</p>')).toBe(true);
    expect(looksLikeHtml('1 < 2 and 3 > 2')).toBe(false);
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
});

describe('checkTemplateFields', () => {
  const variables = ['merchantName', 'amount'];

  it('accepts a valid email and a valid Telegram message', () => {
    expect(checkTemplateFields({ channel: 'email', subject: 'Hi', body: 'Hi {{merchantName}}' }, variables)).toEqual(
      [],
    );
    expect(checkTemplateFields({ channel: 'telegram', subject: '', body: '{{amount}}' }, variables)).toEqual([]);
  });

  it('needs a subject for an email, a body for everything, and ignores the subject of Telegram', () => {
    expect(checkTemplateFields({ channel: 'email', subject: ' ', body: 'x' }, variables).map((p) => p.field)).toEqual([
      'subject',
    ]);
    expect(
      checkTemplateFields({ channel: 'telegram', subject: '', body: '  ' }, variables).map((p) => p.field),
    ).toEqual(['body']);
    expect(checkTemplateFields({ channel: 'telegram', subject: '{{nope}}', body: 'x' }, variables)).toEqual([]);
  });

  it('refuses placeholders the event does not offer, on the field that has them, and lists the ones it does', () => {
    const problems = checkTemplateFields(
      { channel: 'email', subject: '{{typo}}', body: 'Hi {{customerName}} {{amount}}' },
      variables,
    );
    expect(problems.map((p) => p.field)).toEqual(['subject', 'body']);
    expect(problems[1]?.message).toBe(
      'Unknown placeholder {{customerName}}. This event offers {{merchantName}}, {{amount}}.',
    );
    expect(checkTemplateFields({ channel: 'email', subject: 's', body: '{{x}}' }, []).at(-1)?.message).toContain(
      'This event has no placeholders.',
    );
  });

  it('limits the lengths', () => {
    expect(checkTemplateFields({ channel: 'email', subject: 'a'.repeat(201), body: 'x' }, variables)[0]?.code).toBe(
      'too_long',
    );
    expect(checkTemplateFields({ channel: 'telegram', subject: '', body: 'x'.repeat(4097) }, variables)[0]?.code).toBe(
      'too_long',
    );
    expect(checkTemplateFields({ channel: 'email', subject: 's', body: 'x'.repeat(20_001) }, variables)[0]?.code).toBe(
      'too_long',
    );
  });
});

describe('checkLocale', () => {
  it('accepts en and en-GB only', () => {
    expect(checkLocale('en')).toBeUndefined();
    expect(checkLocale('en-GB')).toBeUndefined();
    for (const bad of ['EN', 'english', 'en_GB', 'en-gb', '']) expect(checkLocale(bad)?.field).toBe('locale');
  });
});
