# 051: Supplier keys, supplier answers and field patterns

Status: accepted, 2026-11-21 (feature 41, the security fixes after the review of 2026-11-20). Builds on decisions 019 (credential
encryption), 023 (outbound HTTP), 026 and 042 (Dhru suppliers), 032 (late reads) and 046 (actions kept for Owners).

**Context.** A supplier's saved API key was sent to whatever address, username and driver its row held at call time, so a change of the
address alone moved the key to the new address. The key's hint showed its first five characters. A supplier's answers were stored and
passed on as they came: an answer could be megabytes long, could hold characters Postgres refuses (U+0000, and lone surrogates in JSON),
or a price or balance the money columns cannot hold; each of these could stop the recording of an order, of the call log or of a whole
sync. Field patterns typed by staff were only checked for compiling, then run on every order input on the request path, the anonymous
checkout included, so a pattern with nested repetition could hold the process for seconds. The bulk reply's line reading could take time
in proportion to the square of a line's length. The setting that allows supplier calls over plain http could be changed with
`settings:update`.

**Decision.**
- **A saved key is bound to where it is sent.** A change of a supplier's `baseUrl` to another origin (scheme, host or port), of its
  `username` or of its `driver` carries `apiKey` in the same request, or it is refused with `422` on `apiKey`. A new path on the same origin,
  and changes of the name, currency, limits or status, need no key.
- **The hint shows no part of the key's beginning:** `••••`, followed by the key's last 2 characters when the key has at least 16
  characters. Hints stored before were replaced by `••••`.
- **Supplier text is cleaned and bounded where an answer is read.** Every string of an answer loses U+0000-U+0008, U+000B, U+000C,
  U+000E-U+001F, U+007F-U+009F and lone surrogates and is cut to 20,000 characters; values nested deeper than 32 levels are dropped. What
  is kept is bounded again: an error message to 500 characters, an order's result to 20,000, a reference to 200, names, groups, types,
  times and account details to 300. A cut never splits a surrogate pair, and neither does the masking of a device number in a stored
  call body: the last four characters it keeps are whole characters. Format characters such as right-to-left marks stay (decision 039).
- **Answers have a size.** Up to 256 KiB for the account, the order and its status, 16 MiB for the service list; a larger answer is an
  unusable answer.
- **Amounts have a range.** A price is used from 0 to 1,000,000,000 and a balance from -1,000,000,000 to 1,000,000,000; numbers are read
  exactly and text in exponent form is not an amount. A service whose price is out of range is left out of the sync like one without a
  price (it is unavailable until the supplier lists a usable price); a balance out of range is not saved and the sync goes on; both are
  counted in a warning.
- **A call's log row never stops the order path.** The dispatch, the poll and the scheduled syncs write the call log with a writer that
  falls back to a minimal row and, failing that, logs an error and goes on.
- **Field patterns have a supported form** that cannot backtrack without bound: literals, `.`, character classes, the escapes
  `\d \D \w \W \s \S \t \n \r \f \v \xHH \uHHHH` and escaped syntax characters; groups `( )` and `(?: )` with alternatives, never nested
  and never repeated; the quantifiers `? * + {n} {n,} {n,m}` with counts up to 500; `^` only at the start and `$` only at the end of the
  pattern or of a top-level alternative; and a bound on the work: per top-level alternative, the product of its repeat choices (a value
  has at most 500 characters; a group counts the sum of its alternatives') times (10 + its fixed length), times 501 when the alternative
  does not start with `^`, summed, is at most 20,000,000. The fixed length is the least characters the pieces consume, which the engine
  scans again on every path: a piece without a quantifier counts 1, `?` and `*` count 0, `+` counts 1, `{n}`, `{n,}` and `{n,m}`
  count n, and a group the sum of its alternatives'; a piece whose atom is a bracket class counts 4 times that, because on a value that
  holds a character above U+00FF (stored with 16-bit characters) one character of a class costs about four times a literal, `.` or a
  class escape. A repeat directly followed, in the same sequence, by a literal piece of at least one character that the repeat's atom can
  never match (as in `[^@\s]+@`) has one viable count: its choices leave the product and its choices times its weight (4 for a class,
  else 1) are added to the fixed length. The rule ends at `|`, `(` and `)` and applies only where the atom provably cannot match the
  literal: a different literal, a class escape or a positive class that leaves it out, a negated class that lists it; `.` is taken to
  match every character. Measured with Bun 1.4.4 on 500-character values, Latin-1 ones and ones with characters above U+00FF, the slowest
  accepted pattern found takes about 18 ms (at most 18.8 ms over repeated runs); at 30,000,000 a lazy repeat of a class escape before a
  literal it cannot match took about 25 ms, hence the lower bound. The common mail form `^[^@\s]+@[^@\s]+\.[a-z]{2,10}$` (9,126,000) is accepted. Look-arounds,
  back-references, named groups, `\b`, `\p` and other escapes are refused. A save outside the form is `422` on `fields.N.regex`; a stored
  pattern outside it is not run, so the field has no pattern. The patterns stored before were reviewed once by a worker job, which cleared
  each one outside the form with an audit row and a warning.
- **The bulk reply reads lines** that end at CRLF, CR, LF, U+2028 or U+2029, so reading a line takes time in proportion to its length.
- **Only an Owner changes `suppliers.allowPlainHttp`** (`403` for anyone else; the route keeps `settings:update`). The platform module
  reaches identity's helper through a late read (decision 032).
- **The Prometheus client** goes through the outbound HTTP helper: no redirect is followed and the answer is bounded.

**Rejected.**
- Length CHECK constraints on the result and log columns: a too long text would then fail its write, the failure this removes.
- A regular expression engine with linear time: a new dependency, and a second dialect next to the browsers' own check of the same field.
- Running patterns in a worker thread with a timeout: the request would still wait, and every check would pay for a thread hop.
- Keeping a stored pattern outside the form and skipping it on every order: reporting it once would need a marker; clearing it after
  recording it makes the field's state match what is enforced.
- Computing new hints from the decrypted keys in a migration: a key is decrypted only for a supplier call (decision 019).

**Consequences.** Staff type the key again when they move a supplier to another address, account or API type. Stored hints show only
`••••` until a key is saved again; old audit rows keep the old hints. A service whose price a supplier sends out of range is unavailable
until the supplier fixes it. A pattern staff typed before may have been cleared (audit action "cleared an unsupported field pattern of"):
staff enter a simpler one where it still matters. The call log, the order result and the sync no longer depend on what an answer holds.
