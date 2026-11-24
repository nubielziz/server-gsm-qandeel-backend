// The custom field answers of an order as a person reads them: label and value (decision 065). Pure; no database.
import type { JsonValue } from '../../../common/contract';

/** One answer of an order: the field's hidden key, the label buyers read and the value that was given. */
export interface OrderAnswer {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** The part of a service field {@link orderAnswers} reads: its key, its label and its place in the form. */
export interface AnswerField {
  readonly key: string;
  readonly label: string;
  readonly sort: number;
  /** The field id, to keep the order stable when two fields share a `sort`. */
  readonly id: number;
}

/** A stored value as text: a string as it is, a number or a boolean spelled out, anything nested as JSON; `null` when it holds nothing. */
function textOf(value: JsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.trim() === '' ? null : text;
}

/**
 * Lists the custom field answers of an order with their labels.
 *
 * Why: decision 065: an order stores its answers under the hidden field keys (`orders.inputs`), which staff and merchants cannot read; the
 * order screens show the label and the value instead. The service's fields come first, in form order, each only when it has a value; a
 * stored key that no field has any more (the field was deleted after the order) follows under its own key as the label, so an answer is
 * never hidden because the form changed.
 *
 * @param inputs the order's stored answers by field key
 * @param fields the order's service's fields (any order)
 * @returns the answers: the fields' in form order, then the unknown stored keys in stored order; values as text, empty ones left out
 */
export function orderAnswers(
  inputs: Readonly<Record<string, JsonValue>>,
  fields: readonly AnswerField[],
): OrderAnswer[] {
  const answers: OrderAnswer[] = [];
  const known = new Set<string>();
  const ordered = [...fields].sort((a, b) => a.sort - b.sort || a.id - b.id);
  for (const field of ordered) {
    known.add(field.key);
    const value = Object.hasOwn(inputs, field.key) ? textOf(inputs[field.key]) : null;
    if (value !== null) answers.push({ key: field.key, label: field.label, value });
  }
  for (const [key, stored] of Object.entries(inputs)) {
    if (known.has(key)) continue;
    const value = textOf(stored);
    if (value !== null) answers.push({ key, label: key, value });
  }
  return answers;
}
