// Unit tests of the Scalar page renderer (decision 017): pinned CDN script with integrity, embedded document, and the
// Content-Security-Policy that matches the page it is sent with.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';
import type { OpenApiDocument } from './openapi-types';
import {
  SCALAR_BUNDLE_INTEGRITY,
  SCALAR_BUNDLE_URL,
  SCALAR_CDN_BASE,
  SCALAR_VERSION,
  docsContentSecurityPolicy,
  inlineScriptHashes,
  renderDocsPage,
} from './scalar-page';

const document: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Fixture API', version: '1.0.0', description: 'Tricky: </script><script>alert(1)</script> & "quotes"' },
  paths: {},
};

describe('the pinned CDN script', () => {
  it('names an exact Scalar version, never "latest" or a range', () => {
    expect(SCALAR_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SCALAR_CDN_BASE).toBe(`https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/`);
    expect(SCALAR_BUNDLE_URL.startsWith(SCALAR_CDN_BASE)).toBe(true);
    expect(SCALAR_BUNDLE_INTEGRITY).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  });

  it('is the only external script of the page, with an integrity hash and anonymous CORS', () => {
    const { html } = renderDocsPage(document, 'Fixture');
    const external = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"[^>]*>/g)];
    expect(external).toHaveLength(1);
    expect(external[0]?.[1]).toBe(SCALAR_BUNDLE_URL);
    expect(external[0]?.[0]).toContain(`integrity="${SCALAR_BUNDLE_INTEGRITY}"`);
    expect(external[0]?.[0]).toContain('crossorigin="anonymous"');
    expect(html).not.toMatch(/esm\.js|@latest|api-reference\/(?!dist)/);
  });
});

describe('renderDocsPage', () => {
  it('embeds the document and the page title, and turns telemetry, MCP and the AI agent off', () => {
    const { html } = renderDocsPage(document, 'Fixture <Title>');
    expect(html).toContain('<title>Fixture &lt;Title&gt;</title>');
    expect(html).toContain('"title": "Fixture API"');
    expect(html).toContain('"telemetry": false');
    expect(html).toMatch(/"mcp": \{\s*"disabled": true\s*\}/);
    expect(html).toMatch(/"agent": \{\s*"disabled": true\s*\}/);
    expect(html).toContain('"showDeveloperTools": "never"');
  });

  it('cannot be broken out of by text inside the document', () => {
    const { html } = renderDocsPage(document, 'Fixture');
    // Scalar escapes `<` inside the embedded JSON, so the description never closes the inline script early.
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html.match(/<script/g)).toHaveLength(2);
  });
});

describe('the Content-Security-Policy of a page', () => {
  it('allows exactly the inline starter script of that page, by hash', () => {
    const { html, contentSecurityPolicy } = renderDocsPage(document, 'Fixture');
    const hashes = inlineScriptHashes(html);
    expect(hashes).toHaveLength(1);
    const inline = /<script type="text\/javascript">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(hashes[0]).toBe(createHash('sha256').update(inline).digest('base64'));
    expect(contentSecurityPolicy).toContain(`'sha256-${hashes[0]}'`);
  });

  it('changes when the page changes (a new document means a new hash)', () => {
    const one = renderDocsPage(document, 'Fixture');
    const two = renderDocsPage({ ...document, info: { ...document.info, title: 'Other API' } }, 'Fixture');
    expect(two.contentSecurityPolicy).not.toBe(one.contentSecurityPolicy);
  });

  it('starts from default-src none and opens only script, style, font, img and connect', () => {
    const directives = Object.fromEntries(
      docsContentSecurityPolicy(['abc=']).split('; ').map((part) => {
        const [name = '', ...values] = part.split(' ');
        return [name, values];
      }),
    );
    expect(Object.keys(directives)).toEqual([
      'default-src',
      'script-src',
      'style-src',
      'font-src',
      'img-src',
      'connect-src',
      'base-uri',
      'form-action',
      'frame-ancestors',
    ]);
    expect(directives['default-src']).toEqual(["'none'"]);
    expect(directives['script-src']).toEqual(["'sha256-abc='", SCALAR_CDN_BASE]);
    expect(directives['connect-src']).toEqual(["'self'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
  });

  it('never allows unsafe-inline or unsafe-eval for scripts', () => {
    const policy = renderDocsPage(document, 'Fixture').contentSecurityPolicy;
    const scriptSrc = policy.split('; ').find((part) => part.startsWith('script-src')) ?? '';
    expect(scriptSrc).not.toMatch(/unsafe-/);
    expect(policy).not.toContain('unsafe-eval');
  });
});
