// The errors the customers routes share, built in one place so field names and codes stay identical.
import { AppError } from '../../../common/errors';

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
 * A refused region: `422 VALIDATION_FAILED` on `region`.
 *
 * Why: a country taxed by region is charged the window of the buyer's region, so while one of its regional windows is in force a checkout
 * must name a region that has one; the refusal has the shape of the country's own ("Choose a region.").
 *
 * @returns the error to throw
 */
export function regionNotSupported(): AppError {
  const message = 'Choose a region.';
  return new AppError('VALIDATION_FAILED', {
    detail: message,
    errors: [{ field: 'region', code: 'unsupported', message }],
  });
}

/**
 * `404 NOT_FOUND` for an account id that matches nothing.
 *
 * @returns the error to throw
 */
export function accountNotFound(): AppError {
  return new AppError('NOT_FOUND', { detail: 'No account has this id.' });
}

/**
 * `410 ROUTE_RETIRED`: the address of a customer route that the one account type retired (decision 064).
 *
 * Why: a customer is an account of the retail rank now, so every `/admin/customers` route has an account route that does the same for
 * every rank. The old address stays registered during the expand release and answers this, so a client that still calls it learns what
 * to call instead; it changes nothing. The contract release deletes the handler.
 *
 * @param replacement the account route to use, for the detail (for example `GET /admin/clients`)
 * @returns the error to throw
 */
export function routeRetired(replacement: string): AppError {
  return new AppError('ROUTE_RETIRED', {
    detail: `Customers are accounts of the retail rank now. Use ${replacement}.`,
  });
}
