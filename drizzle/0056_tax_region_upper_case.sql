-- A tax window's region is stored trimmed and in upper case (`normalizeTaxRegion`, src/modules/money/domain/tax-rate-rules.ts), so the
-- one-window rule and the checkout's tax lookup see every spelling of one region as that region. Data only: the rows written before the
-- rule get the same form; `''` (the whole country) stays as it is. Safe to run again: a row already in that form is not touched.
UPDATE "tax_rates" SET "region" = upper(btrim("region", E' \t\n\r\f'))
WHERE "region" <> upper(btrim("region", E' \t\n\r\f'));
