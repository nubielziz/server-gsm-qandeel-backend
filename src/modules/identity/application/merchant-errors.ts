// The validation errors the merchant portal routes share, built in one place so the field names and codes stay identical.
import { AppError } from '../../../common/errors';

/**
 * A refused password: `422 WEAK_PASSWORD` on a field.
 *
 * Why: the staff password policy applies to merchants too (B121); the console-style `errors[]` item names the request key.
 *
 * @param message what is wrong with the password
 * @param field the request key (`password` on register and reset, `newPassword` on change)
 * @returns the error to throw
 */
export function weakPassword(message: string, field: string): AppError {
  return new AppError('WEAK_PASSWORD', { detail: message, errors: [{ field, code: 'WEAK_PASSWORD', message }] });
}

/**
 * A refused authenticator code: `422 VALIDATION_FAILED` on `code`.
 *
 * Why: B121: a wrong code is 422 on its field, never 401, which would sign the caller out.
 *
 * @param detail the sentence for the form field
 * @returns the error to throw
 */
export function invalidCode(detail: string): AppError {
  return new AppError('VALIDATION_FAILED', {
    detail,
    errors: [{ field: 'code', code: 'INVALID_CODE', message: detail }],
  });
}
