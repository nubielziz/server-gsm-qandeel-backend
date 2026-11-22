# 046: Privilege ceiling and owner-only actions

Status: accepted, 2026-11-20 (feature 36). Extends decision 018 (permissions and the Owner rules).

**Context.** Staff get their permissions from their role, checked on every request (decision 018), and a role is a free list of
permission strings. The routes that create and edit roles, add staff, change a member's role and act on another member's account were
each guarded by one permission and by the Owner rule (an account or a role that holds `*` needs an Owner). Within that rule, nothing
compared the permissions handed out or acted on with the caller's own. A few settings decide who can confirm money
or reach the console (a payment method's secrets, a merchant API key made by staff, the IP rules), and some routes carried, under
one coarse permission, a stronger action that has its own permission elsewhere (a refund inside a reject, a retail price inside a
listing edit, a credit limit inside a merchant invitation).

**Decision.**
- **Privilege ceiling.** A staff member grants, assigns or acts on a set of permissions only when each one is covered by their own
  permissions under the grammar of decision 018: a held `area:*` covers its actions; single actions never cover `area:*`; only `*`
  covers `*`. An Owner passes always. It applies to creating a role (its list), editing a role (its current list and the new list, a
  rename included), deleting a role, adding a member (the role given), changing a member's role (the new role), and every action on
  another member's account (edit, password link or temporary password, two-factor reset, ending all sessions, suspend, reactivate, and
  ending one of its sessions from the sessions list). The refusal is `403 FORBIDDEN`. The caller's permissions are the ones the
  permission guard used for the request.
- **Nobody but an Owner edits the role they hold** (`409 CANNOT_CHANGE_OWN_ROLE` for everyone else); a role someone holds cannot be
  deleted (`409 ROLE_IN_USE`). An Owner may edit the role they hold, within the last-Owner rule. The Owner rule and the last-Owner
  rule of decision 018 are unchanged.
- **Kept for Owners.** Adding a payment method that confirms payments by itself (`isManual: false`), any change of `isManual` or of the
  driver of a method that is automatic before or after the change (turning a manual method automatic, an automatic one manual, or giving
  an automatic one another driver), and setting, replacing or removing a method's API secret or webhook secrets. Removing a second
  webhook secret that the method does not have changes nothing and is not counted. A manual method that stays manual, and the plain
  fields of an automatic method, keep the route's own permission. Creating an API key for a merchant from the console (merchants still create their own). For staff who
  are not Owners: a change of the IP rules that would turn an address an active Owner uses from allowed to refused for the console (a
  block of the console or of everything, removing an allow rule while the restriction is on, turning the restriction on); an Owner's
  addresses are those of their live sessions and their last sign-in address. The change is judged as things are and at each later
  moment a rule of either state runs out: an Owner's address may not be refused at any moment at which it would have been allowed
  without the change. The self-lockout rules are unchanged and are checked first.
- **Second permissions.** Where one permission covered a stronger action, the use case also asks for the permission of that action;
  the route keeps its own permission and its description names the second one:
  - a credit limit above zero when a merchant is invited: `wallet:credit_limit`; a price group other than the default group when a
    merchant is invited: `groups:update` (no group, or the default group, needs only the route's permission);
  - suspending, declining or reactivating a merchant: `clients:security`; moving one to another group: `groups:update` (approving a
    merchant stays under the route's own permission);
  - a staff reject of a storefront order that has a captured payment (the payment is given back): `refunds:approve`;
  - the verification decision `refund`: `orders:reopen`;
  - switching a listing on: `storefront:publish`; a listing's retail price or price rule, and a price in a publish run: `pricing:update`;
  - the statement PDF of a merchant: `wallet:read`;
  - the storefront policy `require3ds` (also a risk rule): `risk:*`;
  - a service's `basePrice` or `minProfit`: `pricing:update`;
  - adding a currency, or changing its rate or markup: `currencies:update`.
  The refusal is `403 FORBIDDEN` in the guard's words ("You need the X permission to do this.").
- **One place for the rules.** `uncoveredPermissions` (pure), `assertWithinCeiling`, `requirePermission`, `missingPermission` and
  `requireOwner` (identity, exported first by its index, decision 032) carry these rules and their words; the permission guard uses
  `missingPermission` as well.

**Consequences.**
- A role built from coarse permissions loses the stronger actions above until it is given their permissions; a role that holds an area
  wildcard keeps what the wildcard covers.
- Delegated admins manage staff and roles within their own permissions and never edit the role they hold; an Owner may edit the
  role they hold (the last-Owner rule still protects the last one).
- Owners alone set up automatic payment methods and their secrets, and create merchant keys from the console.
- No permission, route, response shape or error code is added. The console may still offer an action the server now refuses; it shows
  the server's text, and it can hide such controls with `GET /admin/auth/me` (`role`, `permissions`).
- The development seed's role templates are unchanged.
- Not part of this decision: re-authentication before sensitive actions, and approval by a second person.
