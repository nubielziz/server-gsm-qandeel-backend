# 030: PDF rendering (statements and invoices)

Status: accepted, 2026-11-01 (lead resolution money-10). Routes: `GET /admin/reports/client-statement/:clientId` (feature 11),
invoice PDFs (feature 8).

**Decision.**
- PDFs are rendered with `pdf-lib` (pure TypeScript, no native or headless-browser dependency, runs on Bun) behind one
  `PdfRenderer` service in the platform module, shared by the statement and the invoice documents.
- The client statement is the final format `application/pdf`, rendered synchronously in memory and sent whole (amended at feature 11's merge: pdf-lib builds the document in memory), never stored, with an audit
  entry. `Content-Disposition: attachment; filename="statement-<clientId>-<from>-<to>.pdf"` plus `filename*=UTF-8''...`
  (ALIGNMENT § 6); the header is already in the CORS exposed list. Optional query `from` and `to` (`YYYY-MM-DD`, inclusive,
  in the business time-zone setting of finance Q7); the default is the whole history; a bad date or `from` after `to` is
  `422 VALIDATION_FAILED`.
- Statement content: merchant header (name, company, country), period, opening balance, the `client_wallet` lines (date,
  `JRN-<id>`, kind, memo, debit, credit, balance after), closing balance, the credit limit, then the invoices issued in the
  period (number, kind, status, total, paid at).
- An invoice PDF is rendered when the invoice is issued or paid and stored in `files` (S3, `invoices.pdf_file_id`).
- Content is English: Latin fonts are embedded and Arabic shaping is out of scope (amended below).

**Consequences.** One small dependency, no browser to operate; right-to-left text and complex scripts need a different
renderer if the business asks for them later (no longer true for Arabic: see the amendment).

**Amended 2026-11 (feature 24E): Arabic data.** Labels stay English and the page stays left to right, but Arabic data (merchant
and customer names, companies, service titles, notes) is drawn as Arabic in every document (invoices, receipts, statements,
dispute evidence) with no caller change:
- Font: IBM Plex Sans Arabic Regular and Bold (the storefront's Arabic face, SIL OFL 1.1), TrueType files with their license
  under `src/modules/platform/pdf/fonts/` (source release and SHA-256 in its README; a unit test checks the hashes). Not renamed
  or modified; a subset is embedded in a PDF only when the document holds a character Helvetica cannot encode and the font
  can, and only in the weights it uses (`GSMArabic-Regular`, `GSMArabic-Bold`). Latin text stays in the standard Helvetica,
  so a document without Arabic is byte-identical to before (golden test).
- Shaping: `@pdf-lib/fontkit` 1.1.1 (pdf-lib encodes and measures text through fontkit's `layout`, which applies the font's
  GSUB forms and ligatures and reverses a right-to-left run). Verified in the spike: contextual forms, lam-alef as one glyph,
  subsetting keeps the shaped glyphs; the font has no `rtlm` feature and fontkit does not mirror, so brackets are mirrored
  before drawing.
- Order: `bidi-js` 1.1.0 (UAX #9). Each string is cleaned first: bidi control characters (LRM, RLM, ALM, embeddings,
  overrides, isolates) and invisible format characters are removed before any level is computed, so user input cannot reorder
  text (for example reverse an amount); the base direction comes from the first strong character of the paragraph. Wrapping
  works on the logical string; each line is split into runs by level, font and fontkit direction, ordered by rule L2, and a
  run is reversed before drawing when fontkit's own reversal would not give its direction (an odd run without Arabic letters,
  Arabic-Indic digits at an even level). Numbers follow UAX #9 as a browser shows them (an ISO date right after an Arabic
  word reads its groups right to left).
- Truncation (`Sheet.fit`) finds the cut by doubling then bisecting over code points (a logarithmic number of measures):
  each Arabic measure runs bidi and a fontkit layout, so the old one-character-per-pass loop was quadratic and blocked the
  event loop on long Arabic cells (invoices and statements render inside the API process).
- Limits: combining marks (harakat) sit at the font's default position (pdf-lib ignores GPOS anchors); copying or searching
  Arabic text in the PDF may be imperfect (only glyphs with a cmap entry map back to text); the page layout is not mirrored and
  the labels are English (an Arabic document template, with a locale on `PdfDocument`, is a separate feature); scripts other
  than Latin and Arabic still print `?`; a PDF with Arabic grows by the two subsets (a few kilobytes) and its first render in a
  process reads and parses the font files. Invoice PDFs still render after the request's commit; moving them to a job is left
  for after feature 21.
