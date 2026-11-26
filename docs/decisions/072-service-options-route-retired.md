# 072: The option lists of a service lose their write route

Status: accepted, 2026-11-26 (the owner's order of that day). Builds on decisions 061 and 062 (how a row of the map is retired), 068 (the most
recent retirement of a console screen) and 070 (order forms draw only the custom fields).

**Context.** A service in the console had an Options section with three lists, Models, Networks and MEP, saved as whole lists by
`PUT /admin/services/:id/options`. The owner decided on 2026-11-26 to delete the section from the console: an order form draws only a service's custom
fields (decision 070), and production holds no row of `service_options`, so no list was ever saved there. With the section gone nothing calls the
route, and keeping it would keep a use case, a repository function, a domain check, a permission path, an audit sentence and a search signal that
nobody reaches.

**Decision.**

- **`PUT /admin/services/:id/options` is retired.** It is a row of the read-only map, so it stays in the route manifest and is listed in
  `test/contract/retired.ts`; no contract, controller method or use case serves it, and a staff or merchant call gets `404` like any path nothing
  serves. The console does not call it. Gone with it: `ServicePartsService.replaceOptions` and its input type, the repository function that
  replaced the rows (`replaceOptionRows`), the check for a value repeated in a list (`duplicateOptionValues`), the audit sentence `replaced
  option lists of service`, the outbox reason `options` of `catalog.services_changed` (no other writer used it; the search consumer reads no
  reason, so an event written before still runs), and the tests of the route.
- **`PUT /admin/services/:id/fields` stays** with the same rules; `ServicePartsService` now serves it alone and no longer needs
  `CatalogSignals`.

**Kept.**

- The table `service_options` and its schema, unchanged: the map is read-only and its row stays. No migration; production has 0 rows, and a row
  an older release wrote would still read.
- Every read: the `options` array of `GET /admin/services/:id` and of `GET /client/services/:id`, the model and network labels of the search
  documents (`findOptionLabels`), and the demo seed's option rows. A service's `options` array is an empty list when it has no rows.
- The permission `catalog:update` (the other service writes use it) and the error codes of the route's answers (`NOT_FOUND` and
  `VALIDATION_FAILED` serve other routes).
- Custom field patterns (`regex`): the console only hides that column and keeps sending the saved value; nothing changes in the fields route.

**Consequences.** A console or an integration of the previous release that still saves option lists gets `404` after the release; the
console drops the call before the backend release (both work against the backend before and after it). The only trace left in the database is
the rows already stored, read as before. No queue, job, cache key or setting changes; the search index needs no rebuild (labels of rows that
exist are still indexed).

**Retired routes.** `PUT /admin/services/:id/options`.
