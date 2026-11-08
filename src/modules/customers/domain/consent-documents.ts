// How a consent record names its legal document on the customer detail (RESOLUTIONS b2c-14): the label of the document type and
// its version, for example "Terms of service v3.2". Pure functions, unit-tested.

/**
 * The label of each legal document type.
 *
 * Why: RESOLUTIONS b2c-14: "labels: terms 'Terms of service', privacy 'Privacy policy', refund 'Refund policy', cookies
 * 'Cookie policy'".
 */
export const DOCUMENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  terms: 'Terms of service',
  privacy: 'Privacy policy',
  refund: 'Refund policy',
  cookies: 'Cookie policy',
};

/**
 * Names the document of a consent record.
 *
 * @param type the legal document's type, or `null` when the consent has no document (withdrawal waiver, marketing)
 * @param version the document's version text
 * @returns for example `Terms of service v3.2`, or `null` when there is no document
 */
export function documentLabel(type: string | null, version: string | null): string | null {
  if (type === null || version === null) return null;
  return `${DOCUMENT_TYPE_LABELS[type] ?? type} v${version}`;
}
