# 011: Money representation and arithmetic

Status: accepted, 2026-10-31.

**Context.** Never floats. The frontend sends and expects money as decimal strings with 4 fraction digits
(`"12.4900"`), other exact decimals (rates, percents) as strings; pg returns `numeric` as strings (decision 005).

**Decision.**
- Postgres: money `numeric(18,4)`; FX rates `numeric(18,8)`; percentages and tax rates `numeric(9,4)`.
- Wire: Money = string matching `^-?\d+\.\d{4}$`. Other decimals follow the frontend type of each field: a string
  where it declares `Decimal` (rates and percents in pricing, tax, FX), a JSON number where it declares `number`
  (health measures, dashboard percentages, fractions inside snapshots). Contracts enforce it.
- Arithmetic: `decimal.js` behind `src/common/money.ts` (`Money.of`, `add`, `sub`, `mul`, `pct`, `toWire`), scale 4,
  ROUND_HALF_UP, rounding only at named points (price resolution, tax split, FX conversion, gateway fee). Totals and
  balances come from SQL or the ledger, never from summing floats in JS.
- The ledger is kept in the base currency (`settings` base currency, default USD). A B2C payment in another currency
  is recorded at the rate locked in its checkout session; the payment row keeps the original currency and amount.
- Dhru responses format credits as the Dhru fixtures show (decimal strings).

**Consequences.** One helper owns rounding; unit tests cover each money event of the map with its exact numbers.
