# 042: Real Dhru Fusion suppliers

Status: accepted, 2026-11-17 (feature 33, planned by Fable 5.2 from the owner's first refused order, built in one slice by
Opus 5.5 with one Opus review and one fix round, merged by the lead; plan `docs/briefs/33-dhru-fusion-suppliers.md`). Builds
on decisions 023 (what a stored call may hold) and 026 (Dhru compatibility). Spec entry B233, console mismatch M267.

**Context.** Decision 026 fixed the Dhru wire form for **our own** Dhru server: `parameters` is base64 of a JSON object, the
form of the "Dhru API standards v6.1" script a third-party supplier implements. The outbound supplier calls used the same
form. A supplier that runs Dhru Fusion itself does not read it. On 2026-11-17 the owner's first real order was paid from
the store balance and refused by its supplier twice with `Parameter 'ID' Required`, although the call carried `ID`. A
read-only probe (`getimeiorder` for an order that does not exist) settled what that supplier reads: the plain XML string of
the classic Dhru client answered `NoResultFound`; base64 of that XML and base64 of JSON both answered
`Parameter 'ID' Required`. Calls without parameters (`accountinfo`, `imeiservicelist`) work in every form, so the import of
1158 services had shown nothing. The column `suppliers.param_format` (`dhru_xml` for every Dhru supplier) existed and
nothing read it.

The same supplier showed a second gap. The classic service list describes the **main box** of an IMEI service as
`CUSTOM: { allow, customname, customlen, maxlength, regex, ... }`: with `allow` on, the buyer types what `customname` says (an
ECID, a serial number, a lock code) instead of an IMEI, and the value travels as the `IMEI` parameter. Our import read only
`Requires.Custom` (the other fields), so 359 of that supplier's services became IMEI services that demand a real 15-digit
IMEI and refuse every value the supplier takes.

A third gap showed when the owner asked how a supplier's required fields are handled. A Dhru Fusion site marks a required
field of `Requires.Custom` with `"required": "on"` (635 of that supplier's 637 fields); the import accepted only `true`, `1`,
`yes` and `true`, so every field was imported as optional and a buyer could leave out what the supplier demands.

**Decision.**
- **A Dhru supplier is sent its parameters in the format its row says.** `dhru_xml` is the classic string
  `<PARAMETERS><ID>..</ID><IMEI>..</IMEI><QNT>..</QNT><CUSTOMFIELD>..</CUSTOMFIELD></PARAMETERS>`: upper-case keys in the
  order of the call, values escaped (`&`, `<`, `>`), characters XML forbids removed, no declaration, no base64. `json` is
  base64 of a JSON object (decision 026's form). `CUSTOMFIELD` is base64 of a JSON object in both. A Dhru supplier keeps
  `dhru_xml` as its default; no route sets the format yet. The stored call says which format was sent.
- **Our `imei` type keeps its meaning: a 15-digit IMEI with a Luhn digit.** A supplier service whose main box is something
  else (`CUSTOM.allow` on and a name that does not only say IMEI) is a `server` service in our catalog whose first required
  field is that box, with the supplier key `IMEI`. Every channel already draws and checks the fields of a `server`
  service, so no frontend changes. Its pattern comes from the supplier's lengths only.
- **One rule says which field is the supplier's main box**: a value's supplier key is the link's `field_map[key]`, else the
  field's `supplierKey`, else the field's `key`; it is the main box when that resolves to `IMEI`, compared without case. The
  dispatcher sends that value as the `IMEI` parameter, never inside `CUSTOMFIELD`; an IMEI order's own IMEI comes first.
  This also holds for a `server` service staff gave such a field before this decision.
- **Services made before this are adopted on the supplier's next sync**, in the sync's transaction: an `imei` service that
  is not archived, has no main-box field yet and has exactly one active link, pointing at such a supplier service, becomes a
  `server` service: the `server` category of the same name (created with the old one's switch and groups when missing, reused
  as it is when it exists), the box as the first field, one audit row as a system action, the search index told. Price,
  cost, status, quantity, SLA, links and the shop listing stay. The sync answers in `adopted` how many services it brought
  in line with their supplier (the main box, required fields, or both; each service once). A second sync changes nothing.
- **A field the supplier requires is required here.** The import reads `required` as on for `true`, `1` and the texts `on`,
  `1`, `yes`, `true`, `required`, `y`; a `radio` field is a list of options like a `dropdown`; a field marked `adminonly` is
  left out (the supplier's own staff fill it). The supplier's sync repairs the services made before, under the adoption's
  guards: a field whose supplier name matches a field the supplier requires becomes required, with one audit row per
  service. The sync never makes a field optional. Staff who make such a field optional again will see the next sync make
  it required again: the supplier refuses the order without it.
- **The supplier's own patterns (`CUSTOM.regex`, a field's `regexpr`) are never used.** They are untrusted text that would
  run on every order check: one may be written for PHP and match nothing, or backtrack without end. Staff can type a
  pattern on the field.
- **A shop checkout opened before an adoption keeps the buyer's value**: the order is placed with the typed value as the
  main box, as it would have gone before the sync, so nothing a buyer paid for is lost from the order.
- **Order and money rules do not change**: one send per attempt, no automatic re-send, a refusal stops the order for review
  with the hold kept, every call writes its log row.

**Consequences.**
- An order stopped by `Parameter 'ID' Required` before this decision is not repaired by it: staff retry it, or refund it when
  its input is not what the supplier asks for (the first one held a test IMEI where the supplier wants an ECID).
- A supplier that implements the standards v6.1 script needs `param_format = 'json'`, set in the database until a console
  control exists.
- Our own Dhru server still reads only base64 of JSON (decision 026). A merchant whose classic Dhru site sends the XML
  string would get "parameter required" from us: to check with the first merchant that connects one.

**Out of scope.** A console control and an API field for the format; `CUSTOM.isalpha`, `custominfo` and `bulk`; showing the
main box's name on an `imei` service without changing its type (a wire change in three frontends).
