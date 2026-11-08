// The supplier calls of the internal OpenAPI document (decisions 017, 026): the calls this backend makes to a supplier's Dhru Fusion API are no
// routes of ours, so they are listed in the `x-gsm-supplier-calls` extension and named in the description, written from their contracts.
import { type AnySupplierCall, toJsonSchema } from '../../../common/contract';
import type { OpenApiDocument, PlainObject } from './openapi-types';

/**
 * The top-level extension of the internal document that lists the supplier calls.
 *
 * Why: OpenAPI has no place for calls a service makes to someone else; an `x-` extension keeps them in the document without
 * pretending they are routes of ours.
 */
export const SUPPLIER_CALLS_EXTENSION = 'x-gsm-supplier-calls';

/** Where every supplier call goes: the Dhru endpoint of the supplier, a form post (decision 026). */
const TRANSPORT = {
  method: 'POST',
  path: '<supplier>/api/index.php',
  contentType: 'application/x-www-form-urlencoded',
  note: 'The form fields are `username`, `apiaccesskey`, `action`, `requestformat=JSON` and `parameters` (base64 of a JSON object). The call is made by the worker or by a staff action, with the supplier\'s own account.',
} as const;

/** The entry of one call in the extension. */
function entryOf(call: AnySupplierCall): PlainObject {
  const { request, response, error } = call.examples;
  return {
    key: call.key,
    action: call.action,
    summary: call.summary,
    ...(call.description === undefined ? {} : { description: call.description }),
    transport: TRANSPORT,
    bulk: call.bulkAction === null ? null : { action: call.bulkAction, sent: call.sendsBulk },
    parameters: call.params ? toJsonSchema(call.params, 'input') : null,
    // The success entry is what the client accepts, so the side that is parsed (the input) is the one that is documented.
    success: toJsonSchema(call.success, 'input'),
    error: toJsonSchema(call.error, 'input'),
    examples: {
      ...(request === undefined ? {} : { parameters: request }),
      ...(response === undefined ? {} : { answer: { SUCCESS: [response] } }),
      ...(error === undefined ? {} : { refusal: { ERROR: [error] } }),
    },
  };
}

/**
 * Lists the supplier calls in an internal OpenAPI document, in place.
 *
 * Why: decision 026: the supplier layer speaks the Dhru Fusion protocol to the suppliers we buy from. Those calls have contracts (the map
 * keys `SUPPLIER ...`) but no path on this API, so the internal reference names them in its description and carries the schemas in
 * `x-gsm-supplier-calls`. The public document never lists them.
 *
 * @param doc the internal document; changed in place (its `info.description` and a new top-level extension)
 * @param calls the supplier call contracts; nothing changes when the list is empty
 */
export function describeSupplierCalls(doc: OpenApiDocument, calls: readonly AnySupplierCall[]): void {
  if (calls.length === 0) return;
  doc[SUPPLIER_CALLS_EXTENSION] = calls.map(entryOf);
  const lines = calls.map((call) => {
    const bulk = call.bulkAction === null ? '' : ` Bulk variant \`${call.bulkAction}\`: ${call.sendsBulk ? 'sent' : 'never sent'}.`;
    return `- \`${call.action}\`: ${call.summary}.${bulk}`;
  });
  doc.info.description = [
    doc.info.description,
    `**Supplier calls.** Calls this backend makes to a supplier's Dhru Fusion API (\`POST <supplier>/api/index.php\`); they are no routes of this API. Schemas and examples are in \`${SUPPLIER_CALLS_EXTENSION}\`.\n\n${lines.join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
