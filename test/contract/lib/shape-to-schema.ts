// Turns a frontend shape into the JSON Schema it claims (the reverse of the comparator's reading). Used to prove that the
// comparator understands every shape in docs/contract/frontend-endpoints.json and to check that harvested fixtures
// obey the frontend's own types.
import type { JsonSchema } from '../../../src/common/contract';
import type { FrontendShape } from './normalize';

const MONEY_PATTERN = '^-?\\d+\\.\\d{4}$';
const DECIMAL_PATTERN = '^-?\\d+(\\.\\d+)?$';

function leaf(shape: FrontendShape): JsonSchema {
  switch (shape.type ?? '') {
    case 'string':
      switch (shape.alias ?? '') {
        case 'Money':
          return { type: 'string', pattern: MONEY_PATTERN, 'x-gsm-alias': 'Money' };
        case 'Decimal':
          return { type: 'string', pattern: DECIMAL_PATTERN, 'x-gsm-alias': 'Decimal' };
        case 'IsoDateTime':
          return { type: 'string', format: 'date-time', 'x-gsm-alias': 'IsoDateTime' };
        default:
          return { type: 'string' };
      }
    case 'number':
      return shape.alias === 'Id' ? { type: 'integer', 'x-gsm-alias': 'Id' } : { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    case 'null':
      return { type: 'null' };
    case 'json':
      return shape.alias === 'JsonObject'
        ? { 'x-gsm-alias': 'JsonObject', type: 'object', additionalProperties: true }
        : { 'x-gsm-alias': 'JsonValue' };
    default:
      // `any`, `unknown`, `undefined` and opaque types constrain nothing.
      return {};
  }
}

/**
 * Builds the JSON Schema that describes the values a frontend shape allows.
 *
 * Why: the comparator reads shapes and schemas in two different formats; writing a shape back as a schema lets the tests
 * check both readers against each other and validate fixtures against the frontend's own claim.
 *
 * @param shape a shape from `frontend-endpoints.json`
 * @returns a JSON Schema (draft 2020-12 subset) with the `x-gsm-alias` markers
 */
export function shapeToSchema(shape: FrontendShape): JsonSchema {
  let schema: JsonSchema;
  if (shape.anyOf) {
    schema = { anyOf: shape.anyOf.map(shapeToSchema) };
  } else if (shape.const !== undefined) {
    schema = { const: shape.const };
  } else if (shape.enum) {
    schema = { enum: [...shape.enum] };
  } else if (shape.array) {
    schema = { type: 'array', items: shapeToSchema(shape.array) };
  } else if (shape.tuple) {
    schema = { type: 'array', prefixItems: shape.tuple.map(shapeToSchema), items: false };
  } else if (shape.object || shape.record) {
    const entries = Object.entries(shape.object ?? {});
    schema = {
      type: 'object',
      properties: Object.fromEntries(entries.map(([name, child]) => [name, shapeToSchema(child)])),
      required: entries.filter(([, child]) => !child.optional && !child.undefinable).map(([name]) => name),
      // Extra keys are fine in TypeScript's structural typing, so an object without an index signature stays open.
      ...(shape.record ? { additionalProperties: shapeToSchema(shape.record) } : {}),
    };
  } else {
    schema = leaf(shape);
  }
  return shape.nullable ? { anyOf: [schema, { type: 'null' }] } : schema;
}
