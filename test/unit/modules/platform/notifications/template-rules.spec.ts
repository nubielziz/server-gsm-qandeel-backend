// Unit tests of the template rules (feature 12a): placeholders, validation, rendering, the HTML/text split.
import { describe, expect, it } from 'bun:test';
import { IDENTITY_MAIL_EVENTS } from '@src/modules/identity/application/mail/identity-mail-events';
import { IDENTITY_DEFAULT_TEMPLATES } from '@src/modules/identity/application/mail/identity-templates';
import { NotificationEventRegistry } from '@src/modules/platform/notifications/notification-events';
import {
  LINK_MAIL_ATTRIBUTES,
  LINK_MAIL_TAGS,
  checkTemplateFields,
  emailHtml,
  escapeHtml,
  htmlToText,
  linkTemplateProblems,
  looksLikeHtml,
  placeholdersOf,
  protectedTemplateProblems,
  renderMessage,
  renderSubject,
  renderText,
  securityPlaceholderProblem,
  unknownPlaceholders,
} from '@src/modules/platform/notifications/template-rules';
import { SUPPORT_EVENTS } from '@src/modules/support/application/support-events';
import { SUPPORT_DEFAULT_TEMPLATES } from '@src/modules/support/application/support-templates';

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

  it('breaks the line at every form of the line break tag, with or without attributes', () => {
    expect(htmlToText('one<br>two<br/>three<br />four<br class="x">five')).toBe('one\ntwo\nthree\nfour\nfive');
    expect(htmlToText('<p>Read this<br class="x">https://a.example/x</p>')).toBe('Read this\nhttps://a.example/x');
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

describe('emailHtml', () => {
  it('wraps the text in a left-to-right English div', () => {
    expect(emailHtml('Hello')).toBe('<div dir="ltr" lang="en">Hello</div>');
  });

  it('escapes the text, so stored text can never become markup, and turns line breaks into <br>', () => {
    expect(emailHtml('<script>alert(1)</script> & "x"')).toBe(
      '<div dir="ltr" lang="en">&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</div>',
    );
    expect(emailHtml('one\ntwo\r\nthree')).toContain('one<br>\ntwo<br>\nthree');
  });
});

describe('linkTemplateProblems (decision 047)', () => {
  const email = (body: string, subject = 'Hello') => ({ channel: 'email' as const, subject, body });
  const bodyCode = (body: string, subject?: string): string | undefined =>
    linkTemplateProblems(email(body, subject)).find((problem) => problem.field === 'body')?.code;

  it('accepts the shipped link mails and the usual shapes', () => {
    const registry = new NotificationEventRegistry();
    for (const definition of [...IDENTITY_MAIL_EVENTS, ...SUPPORT_EVENTS]) registry.register(definition);
    registry.registerBuiltInTemplates(IDENTITY_DEFAULT_TEMPLATES);
    registry.registerBuiltInTemplates(SUPPORT_DEFAULT_TEMPLATES);
    let checked = 0;
    for (const definition of registry.list().filter((event) => event.secretLink === true)) {
      const shipped = registry.builtInTemplate({
        event: definition.key,
        channel: 'email',
        audience: definition.audience,
      });
      if (shipped === undefined) continue;
      checked += 1;
      expect(linkTemplateProblems(shipped), `${definition.audience}:${definition.key}`).toEqual([]);
    }
    expect(checked).toBeGreaterThan(8);
    for (const body of [
      'Sign in:\n\n{{link}}\n\nThanks',
      '<p>Hi</p><p><a href="{{link}}" style="color:#06c">Sign in</a></p>',
      '<p>{{ link }}</p>',
      '<!doctype html><html><body><p>{{link}}</p></body></html>',
      '<a href="{{link}}">Sign in</a> or copy {{link}}',
      '<p>Go:&nbsp;{{link}}</p>',
      'Call 0800 123 456 or write to support@shop.example.',
    ]) {
      expect(linkTemplateProblems(email(body)), body).toEqual([]);
    }
  });

  it('refuses the link in the subject', () => {
    expect(linkTemplateProblems(email('Sign in: {{link}}', 'Your link {{link}}'))).toEqual([
      expect.objectContaining({ field: 'subject', code: 'link_in_subject' }),
    ]);
    expect(linkTemplateProblems({ channel: 'telegram', subject: '{{link}}', body: 'Open {{link}}' })).toEqual([]);
  });

  it('refuses every tag outside the list, naming the tag', () => {
    for (const tag of ['img', 'style', 'script', 'iframe', 'form', 'link', 'meta', 'base', 'object', 'svg', 'input']) {
      const problems = linkTemplateProblems(email(`<p>{{link}}</p><${tag} src="x">`));
      expect(problems, tag).toEqual([expect.objectContaining({ field: 'body', code: 'link_tag' })]);
      expect(problems[0]!.message, tag).toContain(`<${tag}>`);
    }
    expect(bodyCode('<p>x</p></img>')).toBe('link_tag');
    expect(LINK_MAIL_TAGS).toContain('a');
    expect(LINK_MAIL_ATTRIBUTES).not.toContain('href');
  });

  it('refuses attributes outside the list and href on other tags', () => {
    expect(bodyCode('<a href="{{link}}" ping="x">Go</a>')).toBe('link_attribute');
    expect(bodyCode('<p onclick="x">{{link}}</p>')).toBe('link_attribute');
    expect(bodyCode('<span href="{{link}}">Go</span>')).toBe('link_attribute');
    expect(linkTemplateProblems(email('<p onclick="x">{{link}}</p>'))[0]!.message).toBe(
      'Remove the onclick attribute of the <p> tag.',
    );
  });

  it('refuses an href that is not exactly the link, or not in double quotes', () => {
    expect(bodyCode('<a href="https://example.com/?t={{link}}">Go</a>')).toBe('link_href');
    expect(bodyCode('<a href="#">Go</a>')).toBe('link_href');
    expect(bodyCode('<a href>Go</a>')).toBe('link_href');
    expect(bodyCode("<a href='{{link}}'>Go</a>")).toBe('link_href');
    expect(bodyCode('<a href={{link}}>Go</a>')).toBe('link_href');
  });

  it('refuses the link in two anchors, an anchor without text and an anchor never closed', () => {
    expect(bodyCode('<a href="{{link}}">One</a> <a href="{{link}}">Two</a>')).toBe('link_anchors');
    expect(bodyCode('<a href="{{link}}"></a>')).toBe('link_label');
    expect(bodyCode('<a href="{{link}}">&nbsp;</a>')).toBe('link_label');
    expect(bodyCode('<a href="{{link}}">Sign in')).toBe('link_markup');
  });

  it('refuses the link glued to other text', () => {
    for (const body of [
      'x{{link}}',
      'example.com/{{link}}',
      '<span>example.com/</span>{{link}}',
      '<p title="{{link}}">x</p>',
      '<p>x</p>y{{link}}',
    ]) {
      expect(bodyCode(body), body).toBe('link_placement');
    }
  });

  it('refuses other web addresses, also when they are written with character references', () => {
    for (const body of [
      'Visit https://example.com {{link}}',
      '//example.com {{link}}',
      '&#47;&#47;example.com {{link}}',
      'https&#58;example {{link}}',
      'HTTPS:example {{link}}',
      'a\\\\b {{link}}',
      'java&#9;script:x {{link}}',
      'mailto:a@b.example {{link}}',
      '<p>&#x2F;&#x2f;example.com {{link}}</p>',
    ]) {
      expect(bodyCode(body), body).toBe('link_url');
    }
    expect(bodyCode('Write to support@shop.example about\n{{link}}')).toBeUndefined();
  });

  it('refuses comments, CDATA, declarations, processing instructions and tags that are not closed', () => {
    for (const body of [
      '<!-- hidden -->{{link}}',
      '<![CDATA[x]]> {{link}}',
      '<!ENTITY x "y"> {{link}}',
      '<?xml version="1.0"?> {{link}}',
      '<p class="a {{link}}',
      '<p <b>',
      '<p',
      '</p x>',
    ]) {
      expect(bodyCode(body), body).toBe('link_markup');
    }
  });

  it('refuses an attribute value that carries another address in disguise (a style with an escaped address)', () => {
    expect(bodyCode('<p style="background:u\\72l(x)">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p style="background:url(x)">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p style="width:expression(alert(1))">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p style="@import x">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p style="background:image-set(x)">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p style="background:&#117;rl(x)">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p style="color:#06c;font-weight:bold">{{link}}</p>')).toBeUndefined();
  });

  it('refuses a zero-width character anywhere, and a link that follows anything but a space, tab or line break', () => {
    for (const character of ['\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u2060', '\ufeff']) {
      expect(bodyCode(`${character}{{link}}`), character.charCodeAt(0).toString(16)).toBe('link_markup');
      expect(bodyCode(`Open: ${character} {{link}}`), character.charCodeAt(0).toString(16)).toBe('link_markup');
    }
    // A no-break space is not a separator for the rule (only the four characters are).
    expect(bodyCode('Open:\u00a0{{link}}')).toBe('link_placement');
    expect(bodyCode('Open:\t{{link}}')).toBeUndefined();
    expect(bodyCode('Open:\r\n{{link}}')).toBeUndefined();
  });

  it('reads a body without the tags of the HTML detection as plain text, shown as it is', () => {
    // Not an HTML body (`tr` is not in the detection), so the mail goes out as the raw text: the link follows a ">" there.
    expect(looksLikeHtml('x</tr>{{link}}')).toBe(false);
    expect(bodyCode('x</tr>{{link}}')).toBe('link_placement');
    // The same text as plain text: an entity is not decoded, so it does not make a separator.
    expect(looksLikeHtml('Go:&nbsp;{{link}}')).toBe(false);
    expect(bodyCode('Go:&nbsp;{{link}}')).toBe('link_placement');
  });

  it('finishes quickly on long hostile input', () => {
    for (const body of [
      '<a x="'.repeat(20_000),
      '{{link'.repeat(20_000),
      '{{ '.repeat(30_000),
      '<'.repeat(100_000),
      '&#'.repeat(50_000),
    ]) {
      const start = performance.now();
      linkTemplateProblems(email(body));
      expect(performance.now() - start, `${body.slice(0, 8)} (${body.length})`).toBeLessThan(250);
    }
  });
});

describe('securityPlaceholderProblem (decision 047)', () => {
  const fields = (body: string) => ({ channel: 'email' as const, subject: 'x', body });

  it('wants the link in the body of a security link mail, and {{change}} in a security notice', () => {
    const linkMail = { security: true, secretLink: true };
    const notice = { security: true };
    expect(securityPlaceholderProblem(linkMail, fields('Open {{ link }}'))).toBeUndefined();
    expect(securityPlaceholderProblem(linkMail, fields('Open the page'))).toEqual({
      field: 'body',
      code: 'security_placeholder',
      message: 'This email protects accounts: keep {{link}} in the message.',
    });
    expect(securityPlaceholderProblem(notice, fields('We changed {{change}}.'))).toBeUndefined();
    expect(securityPlaceholderProblem(notice, fields('We changed something.'))).toEqual({
      field: 'body',
      code: 'security_placeholder',
      message: 'This email protects accounts: keep {{change}} in the message, it says what changed.',
    });
  });

  it('asks nothing of an event that does not protect accounts', () => {
    expect(securityPlaceholderProblem({ secretLink: true }, fields('no link'))).toBeUndefined();
    expect(securityPlaceholderProblem({}, fields('anything'))).toBeUndefined();
  });
});

describe('an attribute value holds no character reference the scan does not read (decision 047)', () => {
  const email = (body: string) => ({ channel: 'email' as const, subject: 'Hello', body });
  const bodyCode = (body: string): string | undefined =>
    linkTemplateProblems(email(body)).find((problem) => problem.field === 'body')?.code;

  it('refuses a named reference outside the list the scan decodes, in a style and in other attributes', () => {
    for (const body of [
      '<p style="background:url&lpar;x&rpar;">{{link}}</p>',
      '<p style="width:expression&lpar;1&rpar;">{{link}}</p>',
      '<p title="a&excl;b">{{link}}</p>',
      '<p title="&lbrace;x">{{link}}</p>',
      '<p class="&NotANameWeKnow;">{{link}}</p>',
      '<p title="a&copy">{{link}}</p>',
    ]) {
      expect(bodyCode(body), body).toBe('link_url');
    }
    // An href holds exactly the link, so a reference next to it is refused as a wrong href.
    expect(bodyCode('<a href="&lpar;{{link}}">Go</a>')).toBe('link_href');
    expect(bodyCode('<a href="{{link}}&colon;x">Go</a>')).toBe('link_href');
  });

  it('still judges the references it decodes after decoding them', () => {
    // Decoded, they spell a risky value or another address.
    expect(bodyCode('<p style="background:&#117;rl(x)">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p style="background:&#x75;rl(x)">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p title="java&#115;cript&colon;x">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p title="&sol;&sol;example.com">{{link}}</p>')).toBe('link_url');
    // A numeric reference is read with any number of digits, leading zeros included.
    expect(bodyCode('<p style="background:&#00000117;rl(x)">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p style="background:&#x00000075;rl(x)">{{link}}</p>')).toBe('link_url');
    expect(bodyCode('<p>https&#000000058;&#000000047;&#000000047;example.com</p> {{link}}')).toBe('link_url');
    expect(bodyCode('<p title="&#0000000169;">{{link}}</p>')).toBeUndefined();
    // Decoded, they are harmless: the value is accepted.
    expect(bodyCode('<p title="Tom &amp; Jerry &quot;at&quot; home&nbsp;&#169;">{{link}}</p>')).toBeUndefined();
    expect(bodyCode('<p style="color:#06c;font-weight:bold">{{link}}</p>')).toBeUndefined();
  });

  it('leaves an ampersand in the text of the body alone, and a bare ampersand in a value', () => {
    expect(bodyCode('Tom & Jerry &lpar; AT&T\n{{link}}')).toBeUndefined();
    expect(bodyCode('<p>Tom & Jerry &lpar; AT&T</p><p>{{link}}</p>')).toBeUndefined();
    expect(bodyCode('<p title="Tom & 5">{{link}}</p>')).toBeUndefined();
  });
});

describe('the text part reads what the scan accepts (decision 047)', () => {
  const LINK = 'https://shop.example/set-password?token=abc&x=1';
  const email = (body: string) => ({ channel: 'email' as const, subject: 'Hello', body });
  const render = (body: string) => renderMessage(email(body), { link: LINK, name: 'Sam' });
  const occurrences = (text: string, part: string) => text.split(part).length - 1;
  const bodyCode = (body: string): string | undefined =>
    linkTemplateProblems(email(body)).find((problem) => problem.field === 'body')?.code;

  it('holds the link exactly once and no markup for every body the scan accepts', () => {
    const accepted = [
      'Sign in:\n\n{{link}}\n\nThanks',
      '<p>Hi {{name}}</p><p><a href="{{link}}">Sign in</a></p>',
      '<a href="{{link}}" style="color:#06c" target="_blank">Sign in</a>',
      '<A HREF = "{{link}}">Sign in</A>',
      '<a title="Sign in" href="{{link}}" class="button">Sign <b>in</b></a>',
      '<a href="{{link}}"title="x">Go</a>',
      '<p>Open:\n<a\nhref="{{link}}"\n>Sign in</a></p>',
      '<a href="{{link}}"/>Go</a>',
      '<a href="{{link}}">{{link}}</a>',
      '<html><body><p>{{link}}</p></body></html>',
      '<p>Go:&nbsp;{{link}}</p>',
      '<!doctype html><p>{{link}}</p>',
      '<ul><li>Step one</li><li><a href="{{link}}">Sign in</a></li></ul>',
      '<table><tr><td align="left" width="100%"><a href="{{link}}">Sign in</a></td></tr></table>',
      '<p title="Q &amp; A">{{link}}</p>',
      '<p>Tom &amp; Jerry</p><p>{{link}}</p>',
      '<a>No address here</a> <a href="{{link}}">Sign in</a>',
      '<br>{{link}}<br/>',
      '<p>Read this<br class="x">{{link}}</p>',
    ];
    for (const body of accepted) {
      expect(linkTemplateProblems(email(body)), body).toEqual([]);
      const { text } = render(body);
      expect(occurrences(text, LINK), body).toBe(1);
      expect(text, body).not.toMatch(/[<>]/);
    }
  });

  it('refuses the anchor shapes the text part does not read', () => {
    for (const body of [
      // An end tag with anything between its name and ">".
      '<a href="{{link}}">Sign in</a >',
      '<a href="{{link}}">Sign in</a\n>',
      '<p>x</p >{{link}}',
      // A tag end, a tag start or a double quote inside an attribute value, or the word href in one.
      '<a title="x>y" href="{{link}}">Go</a>',
      '<a title="x<y" href="{{link}}">Go</a>',
      '<a href="{{link}}" title=\'x" href="www.other.example\'>Go</a>',
      '<a href="{{link}}" title="href=">Go</a>',
      '<a title=href href="{{link}}">Go</a>',
      // A lone "<" in an HTML body: the text part reads it as the start of a tag and drops what follows up to the next ">".
      '<p>1 < 2 <a href="{{link}}">Go</a> and 3 > 2</p>',
      '<p>x < y</p><p>{{link}}</p>',
    ]) {
      expect(bodyCode(body), body).toBe('link_markup');
    }
  });

  it('keeps a lone "<" in a body that goes out as plain text, where nothing reads tags', () => {
    expect(looksLikeHtml('if a < b then\n{{link}}')).toBe(false);
    expect(bodyCode('if a < b then\n{{link}}')).toBeUndefined();
    expect(render('if a < b then\n{{link}}').text).toBe('if a < b then\n' + LINK);
  });
});

describe('protectedTemplateProblems: the template of a security email (decision 047)', () => {
  const email = (body: string, subject = 'Hello') => ({ channel: 'email' as const, subject, body });
  const notice = { security: true } as const;
  const linkMail = { security: true, secretLink: true } as const;
  const ticketMail = { secretLink: true } as const;
  const codes = (event: { security?: boolean; secretLink?: boolean }, body: string, subject?: string): string[] =>
    protectedTemplateProblems(event, email(body, subject)).map((problem) => `${problem.field}:${problem.code}`);

  it('accepts every shipped text of every security and link event', () => {
    const registry = new NotificationEventRegistry();
    for (const definition of [...IDENTITY_MAIL_EVENTS, ...SUPPORT_EVENTS]) registry.register(definition);
    registry.registerBuiltInTemplates(IDENTITY_DEFAULT_TEMPLATES);
    registry.registerBuiltInTemplates(SUPPORT_DEFAULT_TEMPLATES);
    let notices = 0;
    let links = 0;
    for (const definition of registry.list()) {
      if (definition.security !== true && definition.secretLink !== true) continue;
      const shipped = registry.builtInTemplate({
        event: definition.key,
        channel: 'email',
        audience: definition.audience,
      });
      if (shipped === undefined) continue;
      if (definition.secretLink === true) links += 1;
      else notices += 1;
      expect(protectedTemplateProblems(definition, shipped), `${definition.audience}:${definition.key}`).toEqual([]);
    }
    // The merchant's two notices (staff action, key made in the portal), the customer's, the note to an address without an account and the
    // notice that the finish of a sign-up set a password (decision 079). The two sign-up mails of decision 079 are links.
    expect(notices).toBe(5);
    expect(links).toBeGreaterThan(8);
  });

  it('accepts the shapes of a notice that show {{change}} in the text', () => {
    for (const body of [
      'Hi {{merchantName}}, we changed this: {{change}}.',
      '<p>Hi {{merchantName}}</p><p><strong>{{change}}</strong></p>',
      '<p title="Security notice" class="notice">{{ change }}</p>',
      '<table><tr><td align="left">{{change}}</td></tr></table>',
      'Tom & Jerry say {{change}} <b>now</b>',
    ]) {
      expect(codes(notice, body), body).toEqual([]);
    }
  });

  it('scans a notice the way a link mail is scanned: comments, declarations and tags outside the list', () => {
    for (const body of [
      '<!-- hidden -->{{change}}',
      '<![CDATA[x]]> {{change}}',
      '<!ENTITY x "y"> {{change}}',
      '<?xml version="1.0"?> {{change}}',
      '<p class="a {{change}}',
      '<p>{{change}}</p></p x>',
      '\u200b{{change}}',
    ]) {
      expect(codes(notice, body), body).toEqual(['body:link_markup']);
    }
    for (const tag of ['img', 'style', 'script', 'iframe', 'form', 'link', 'meta', 'base', 'object', 'svg', 'input']) {
      expect(codes(notice, `<p>{{change}}</p><${tag} src="x">`), tag).toEqual(['body:link_tag']);
    }
  });

  it('refuses a style or hidden attribute in the template of every security email', () => {
    for (const event of [notice, linkMail]) {
      const target = event === notice ? '{{change}}' : '<a href="{{link}}">Go</a>';
      expect(codes(event, `<p style="display:none">x</p><p>${target}</p>`)).toEqual(['body:link_attribute']);
      expect(codes(event, `<p style="color:#06c">${target}</p>`)).toEqual(['body:link_attribute']);
      expect(codes(event, `<p hidden>${target}</p>`)).toEqual(['body:link_attribute']);
      expect(codes(event, `<p HIDDEN="hidden">${target}</p>`)).toEqual(['body:link_attribute']);
    }
    expect(protectedTemplateProblems(notice, email('<p style="display:none">x</p>{{change}}'))[0]!.message).toBe(
      'Remove the style attribute of the <p> tag.',
    );
    // A link email that is no security email (a ticket mail) keeps its style.
    expect(codes(ticketMail, '<p style="color:#06c"><a href="{{link}}">Go</a></p>')).toEqual([]);
    expect(codes(ticketMail, '<p hidden>{{link}}</p>')).toEqual(['body:link_attribute']);
  });

  it('refuses an href in a notice, which has no link to carry', () => {
    expect(codes(notice, '<a href="https://example.com">x</a> {{change}}')).toEqual(['body:link_attribute']);
    expect(codes(notice, '<a>no address</a> {{change}}')).toEqual([]);
  });

  it('wants {{change}} or {{link}} in the text the reader sees, outside every tag, attribute and comment', () => {
    // Only in an attribute: the body has it, the reader does not see it.
    expect(codes(notice, '<p title="{{change}}">Something changed.</p>')).toEqual(['body:security_placeholder']);
    expect(protectedTemplateProblems(notice, email('<p title="{{change}}">Something changed.</p>'))[0]!.message).toBe(
      'This email protects accounts: {{change}} must stand in the text of the message, not inside a comment or a tag.',
    );
    expect(codes(notice, '<p title="x {{change}}">{{change}}</p>')).toEqual(['body:security_placeholder']);
    // As the name of an attribute it is no text either.
    expect(codes(notice, '<p {{change}}>Something changed.</p>')).toEqual(['body:link_attribute']);
    // Only in a comment: the comment is refused, and that one problem is enough.
    expect(codes(notice, '<!-- {{change}} -->Something changed.')).toEqual(['body:link_markup']);
    // Split by a tag, or missing: the body does not have it.
    expect(codes(notice, '{{<b>change</b>}}')).toEqual(['body:security_placeholder']);
    expect(protectedTemplateProblems(notice, email('Something changed.'))[0]!.message).toBe(
      'This email protects accounts: keep {{change}} in the message, it says what changed.',
    );
    // The link: in the text or as the address of the link; never only in another attribute or a comment.
    expect(codes(linkMail, '<p><a href="{{link}}">Sign in</a></p>')).toEqual([]);
    expect(codes(linkMail, 'Open {{link}}')).toEqual([]);
    expect(codes(linkMail, '<p title="{{link}}">Open the page.</p>')).toEqual(['body:link_placement']);
    expect(codes(linkMail, '<!-- {{link}} -->Open the page.')).toEqual(['body:link_markup']);
    expect(codes(linkMail, '<p>Open the page.</p>')).toEqual(['body:security_placeholder']);
    // A refused body that also lacks the placeholder reports both.
    expect(codes(linkMail, '<img src="x"><p>Open the page.</p>')).toEqual([
      'body:link_tag',
      'body:security_placeholder',
    ]);
  });

  it('asks the link rules of a link email for its subject, and nothing of an event that protects nothing', () => {
    expect(codes(linkMail, 'Open {{link}}', 'Your {{link}}')).toEqual(['subject:link_in_subject']);
    expect(codes({}, '<img src="x"><!-- c --><p style="x" hidden>{{link}}</p>')).toEqual([]);
  });

  it('finishes quickly on long hostile input', () => {
    for (const body of [
      '<p title="'.repeat(20_000),
      '{{change'.repeat(20_000),
      '<'.repeat(100_000),
      '&#'.repeat(50_000),
    ]) {
      const start = performance.now();
      protectedTemplateProblems(notice, email(body));
      protectedTemplateProblems(linkMail, email(body));
      expect(performance.now() - start, `${body.slice(0, 8)} (${body.length})`).toBeLessThan(500);
    }
  });
});
