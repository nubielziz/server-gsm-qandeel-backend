// JSON Schema validation (ajv, draft 2020-12, with formats) for harvested fixtures and OpenAPI examples.
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

/**
 * Creates the validator the contract tests share.
 *
 * Why: the schemas come from zod and OpenAPI, which use JSON Schema 2020-12 plus `x-*` extensions and formats such as
 * `date-time`; non-strict mode accepts the extensions, formats are checked.
 *
 * @returns an Ajv instance for draft 2020-12 with the standard formats
 */
export function createValidator(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true, logger: false });
  addFormats(ajv);
  return ajv;
}

/**
 * Validates a value and lists what is wrong.
 *
 * @param ajv a validator from {@link createValidator}
 * @param schema a JSON Schema (draft 2020-12)
 * @param value the value to check
 * @returns one line per problem (`/data/0/status must be equal to one of the allowed values`); empty when valid
 */
export function validationErrors(ajv: Ajv2020, schema: object, value: unknown): string[] {
  const validate = ajv.compile(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map((error) => `${error.instancePath || '(root)'} ${error.message ?? 'is not valid'}`);
}
