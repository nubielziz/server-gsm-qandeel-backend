-- auth_tokens.browser_hash: the keyed hash of the cookie POST /store/v1/auth/magic-link gives the browser that asked for a storefront
-- sign-in link, so POST /store/v1/auth/verify can tell that browser from another one. NULL for every link that exists and for every other
-- kind of link (staff, merchants, invitations, resets, email verification): such a link counts as asked for elsewhere.
ALTER TABLE "auth_tokens" ADD COLUMN "browser_hash" text;
