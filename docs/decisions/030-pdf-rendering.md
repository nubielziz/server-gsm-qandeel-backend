# 030: PDF rendering (statements and invoices)

Status: accepted, 2026-11-01 (lead resolution money-10). Routes: `GET /admin/reports/client-statement/:clientId` (feature 11),
invoice PDFs (feature 8).

**Decision.**
- PDFs are rendered with `pdf-lib` (pure TypeScript, no native or headless-browser dependency, runs on Bun) behind one
  `PdfRenderer` service in the platform module, shared by the statement and the invoice documents.
- The client statement is the final format `application/pdf`, rendered synchronously and streamed, never stored, with an audit
  entry. `Content-Disposition: attachment; filename="statement-<clientId>-<from>-<to>.pdf"` plus `filename*=UTF-8''...`
  (ALIGNMENT § 6); the header is already in the CORS exposed list. Optional query `from` and `to` (`YYYY-MM-DD`, inclusive,
  in the business time-zone setting of finance Q7); the default is the whole history; a bad date or `from` after `to` is
  `422 VALIDATION_FAILED`.
- Statement content: merchant header (name, company, country), period, opening balance, the `client_wallet` lines (date,
  `JRN-<id>`, kind, memo, debit, credit, balance after), closing balance, the credit limit, then the invoices issued in the
  period (number, kind, status, total, paid at).
- An invoice PDF is rendered when the invoice is issued or paid and stored in `files` (S3, `invoices.pdf_file_id`).
- Content is English: Latin fonts are embedded and Arabic shaping is out of scope.

**Consequences.** One small dependency, no browser to operate; right-to-left text and complex scripts need a different
renderer if the business asks for them later.
