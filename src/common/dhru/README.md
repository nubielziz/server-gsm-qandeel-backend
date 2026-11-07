# Dhru gateway (`src/common/dhru`)

The one adapter between the Dhru Fusion v6.1 endpoint `POST /api/index.php` and the modules that own its eight actions (decision 026,
feature 7a). Nothing here touches a table; it is global, like the clock and the error registry, so no module imports another to reach it.

| File | What it holds |
|---|---|
| `define-dhru-action.ts` | `defineDhruAction`: the contract of one action (key `DHRU <action>` as in the manifest, the zod schema of its decoded `parameters` and of the entry of its `SUCCESS` list, the catalog error codes, examples checked against the schemas at boot) and `dhruActionRegistry`. |
| `dhru-envelope.ts` | The wire format that is not action-specific: `dhruSuccess`, `dhruError`, `dhruBulk` (answers keyed by the caller's request id, `apiversion` last), `decodeBase64Object` (`parameters` and `CUSTOMFIELD`: base64 JSON, a `+` that arrived as a space is put back), `readParameters`, `readCustomFields`, `dhruStatusOf` (0 new, 1 in process, 3 rejected, 4 completed) and `DHRU_HEADERS`. |
| `dhru-gateway.ts` | `DhruGateway`: a module `bind`s a handler to each action contract it owns; `execute` reads the `action`, validates the parameters, runs the handler and shapes its entry with the success schema. A bulk action runs each item on its own, in order, and answers each as `SUCCESS` or `ERROR` (at most 100 items). |
| `dhru.module.ts` | `DhruModule` (global): provides the gateway. |

How the surface fits together:

- **Transport** (orders module): `POST /api/index.php` (`controllers/dhru.controller.ts`) is a normal contract (`access: 'dhru-credentials'`,
  `bodyType: 'form'`). The guard (`DhruCredentialsAccessHandler`, identity) checks `username` and `apiaccesskey` (scope `dhru`, allowed
  addresses, the key's limit); the controller hands the action to the gateway and sets `X-Powered-By` and `dhru-fusion-api-version`.
- **Owners**: money binds `accountinfo`, catalog `imeiservicelist`, orders the other six, each in `onModuleInit`.
- **Errors**: a single action throws its `AppError`; `DhruErrorFormatter` (`src/common/errors`) answers it as `{ ERROR: [{ MESSAGE }], apiversion }`
  with HTTP 200 and counts it under its catalog code. A bulk item that fails is answered inside the bulk body, and the gateway counts and
  logs it (no exception reaches the filter for it).
- **Documentation**: the platform module writes every registered action into the Dhru operation of the OpenAPI documents
  (`describeDhruActions`).
- **Tests**: unit specs next to the files; one fixture per action in `test/dhru/` (keys and types checked byte for byte);
  `test/integration/dhru-surface.test.ts` for the surface on the real application.
