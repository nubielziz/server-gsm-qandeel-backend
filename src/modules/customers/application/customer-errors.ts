// The errors the customers routes share, built in one place so field names and codes stay identical.
import { AppError } from '../../../common/errors';

/**
 * A refused password: `422 WEAK_PASSWORD` on a field.
 *
 * Why: the staff password policy applies to customers too; the console-style `errors[]` item names the request key.
 *
 * @param message what is wrong with the password
 * @param field the request key (`password` on set, `newPassword` on change)
 * @returns the error to throw
 */
export function weakPassword(message: string, field: string): AppError {
  return new AppError('WEAK_PASSWORD', { detail: message, errors: [{ field, code: 'WEAK_PASSWORD', message }] });
}

/**
 * A refused email: `422 VALIDATION_FAILED` on `email` with no code of its own.
 *
 * Why: RESOLUTIONS b2c-16: a blocklisted email is `422` with `errors[{field:'email', message:'This email is blocked.'}]`.
 *
 * @returns the error to throw
 */
export function emailBlocked(): AppError {
  const message = 'This email is blocked.';
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [{ field: 'email', code: 'blocked', message }],
  });
}

/**
 * A refused country: `422 VALIDATION_FAILED` on `country`.
 *
 * Why: ANSWERS customers Q8: staff can only give a customer a country the storefront sells to (one with a current tax rate);
 * the message is the console's own ("Choose a country.").
 *
 * @returns the error to throw
 */
export function countryNotSupported(): AppError {
  const message = 'Choose a country.';
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [{ field: 'country', code: 'unsupported', message }],
  });
}

/**
 * `404 NOT_FOUND` for a customer id that matches nothing.
 *
 * @returns the error to throw
 */
export function customerNotFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No customer has this id.' });
}
