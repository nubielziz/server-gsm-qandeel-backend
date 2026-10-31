// OpenAPI examples (docs/contract/TESTS.md § 2): every example in the committed documents validates against the schema
// next to it, so the documentation never shows a body the API would not send or accept.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib/inputs';
import { createValidator, validationErrors } from './lib/validate';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const DOCUMENT_ID = 'urn:gsm:openapi';

/** A JSON Pointer into the document, written for use in a `$ref` fragment. */
const pointer = (...segments: (string | number)[]): string =>
  `/${segments.map((segment) => encodeURIComponent(String(segment).replaceAll('~', '~0').replaceAll('/', '~1'))).join('/')}`;

/** One example found in a document, with the pointer of the schema it must satisfy. */
interface Example {
  readonly where: string;
  readonly schema: string;
  readonly value: unknown;
}

/** Examples of a media type map (`content`): `example`, and each `examples.<name>.value`. */
function fromContent(where: string, base: (string | number)[], content: unknown): Example[] {
  const found: Example[] = [];
  if (!isObject(content)) return found;
  for (const [mediaType, media] of Object.entries(content)) {
    if (!isObject(media) || media.schema === undefined) continue;
    const schema = pointer(...base, 'content', mediaType, 'schema');
    const here = `${where} ${mediaType}`;
    if ('example' in media) found.push({ where: `${here} example`, schema, value: media.example });
    if (isObject(media.examples)) {
      for (const [name, example] of Object.entries(media.examples)) {
        if (isObject(example) && 'value' in example)
          found.push({ where: `${here} examples.${name}`, schema, value: example.value });
      }
    }
  }
  return found;
}

/** Every example of a `paths` or `webhooks` map: parameters, request bodies and responses. */
function fromOperations(root: 'paths' | 'webhooks', items: unknown): Example[] {
  const found: Example[] = [];
  if (!isObject(items)) return found;
  for (const [name, item] of Object.entries(items)) {
    if (!isObject(item)) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.includes(method) || !isObject(operation)) continue;
      const base: (string | number)[] = [root, name, method];
      const where = `${root} ${method.toUpperCase()} ${name}`;
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      parameters.forEach((parameter: unknown, index) => {
        if (isObject(parameter) && parameter.schema !== undefined && 'example' in parameter) {
          found.push({
            where: `${where} parameter ${String(parameter.name)}`,
            schema: pointer(...base, 'parameters', index, 'schema'),
            value: parameter.example,
          });
        }
      });
      if (isObject(operation.requestBody)) {
        found.push(...fromContent(`${where} request`, [...base, 'requestBody'], operation.requestBody.content));
      }
      for (const [status, response] of Object.entries(isObject(operation.responses) ? operation.responses : {})) {
        if (isObject(response))
          found.push(...fromContent(`${where} ${status}`, [...base, 'responses', status], response.content));
      }
    }
  }
  return found;
}

for (const file of ['openapi.json', 'openapi.public.json']) {
  describe(`docs/contract/${file}`, () => {
    const document = JSON.parse(readFileSync(join(ROOT, 'docs', 'contract', file), 'utf8')) as Json;
    const examples = [...fromOperations('paths', document.paths), ...fromOperations('webhooks', document.webhooks)];

    it('has examples to check', () => {
      // The public document describes REST v1 and the events only; before those features exist it has no example.
      if (file === 'openapi.json') expect(examples.length).toBeGreaterThan(0);
    });

    it('has examples that satisfy their schemas', () => {
      const ajv = createValidator();
      // The whole document is one schema resource, so a `$ref` such as #/components/schemas/X resolves inside it.
      ajv.addSchema({ ...document, $id: DOCUMENT_ID });
      const wrong: string[] = [];
      for (const example of examples) {
        for (const problem of validationErrors(ajv, { $ref: `${DOCUMENT_ID}#${example.schema}` }, example.value)) {
          wrong.push(`${example.where}: ${problem}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    it('rejects a value that does not fit (the check is live)', () => {
      const ajv = createValidator();
      ajv.addSchema({ ...document, $id: DOCUMENT_ID });
      // An array is never a valid object example, so a schema that really describes the example's object rejects it.
      const objectExample = examples.find((example) => isObject(example.value));
      if (file === 'openapi.json') expect(objectExample).toBeDefined();
      if (!objectExample) return;
      expect(validationErrors(ajv, { $ref: `${DOCUMENT_ID}#${objectExample.schema}` }, []).length).toBeGreaterThan(0);
    });
  });
}
