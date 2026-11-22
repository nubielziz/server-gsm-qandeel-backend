# 047: Staff access to customer data, and changes that move an account

Status: accepted, 2026-11-22 (feature 37). Extends decisions 018, 033 and 046.

**Context.** Staff change the details of merchants and storefront customers, edit the texts of the emails the system sends, download
stored files and read lists that show customers' contact details. Some of these actions decided more than their permission said: an email
address is where an account's sign-in and password links go, so changing it moves the account; the templates of the emails that carry
one-time links decide where those links appear; a file download served every kind of file (identity documents, payment receipts, order
files) under one permission; the console masked customers' addresses on its pages while the answers carried them in full.

**Decision.**
- **Email changes.** Changing the email address of a merchant also needs `clients:security`; changing the address of a storefront customer
  who has an account also needs `customers:password` (a guest's needs only the route's permission: a guest holds no balance and no password,
  and its address signs in only by a link that the address itself receives). These are the permissions that already guard temporary
  passwords and ending sessions. The change ends every session of the account and sends a security notice to the address before the change
  (`merchant.security_notice`; for customers the new event `customer.security_notice`); the verification still goes to the new address.
  Creating a customer account with a temporary password (a new customer, or an account for a guest) also needs `customers:password`; the
  invitation link needs only the route's permission. A refusal is `403 FORBIDDEN` and changes nothing.
- **Emails that carry a one-time link.** For the events whose `{{link}}` is a credential (the sign-in, password, invitation and
  verification links of merchants, customers and staff; the ticket links; the checkout reminder) a template keeps the link in the
  message: `{{link}}` stands on its own in the text (at the start, or after a space, a tab or a line break) or is the whole `href`,
  written in double quotes, of one link that has a text; it is never in the subject; the message holds no other web address (also when it is
  written with character references or in a style value), no character that shows nothing, and only text formatting tags, with a short
  list of attributes. An attribute value holds no named character reference outside the short list the check decodes, and no `<`, `>`,
  double quote or the word `href`; an end tag has its `>` right after its name; a lone `<` in an HTML message is written `&lt;`: the text part of
  the email is made from the same markup, and it must read every link the check accepted. A template that does not keep to this is refused
  when it is saved (`422` on `subject` or `body`). When an email is
  written from a stored template that does not keep to it, the shipped text of the event is used instead and a warning is logged; an event
  without a shipped text (the checkout reminder) sends nothing, and while its stored template breaks the rules it counts as switched off.
- **Security emails.** The link emails of accounts (sign-in, password, invitation, verification) and the security notices cannot be
  switched off or deleted (`409 LOCKED`). Their templates keep what the email protects: `{{link}}` in a link email and `{{change}}` in
  a notice (`422` on `body`, code `security_placeholder`), and it stands in the text the reader sees: outside every tag, attribute and
  comment. The body of every security email, a notice included, is checked like the body of a link email for comments, `<!...>` and
  `<?...>` blocks and tags outside the list, refuses a `style` or `hidden` attribute, and a notice holds no `href`. A stored text that does
  not keep to this, or lost the placeholder, is replaced by the shipped text when the email is written. A missing or switched-off template
  of one of them does not stop the email: the shipped text is sent.
- **File downloads.** `GET /admin/files/:id` also needs the read permission of every record that uses the file: `kyc:read` (an identity
  document), `payments:read` (a payment receipt), `disputes:read` (dispute evidence), `orders:read` (an order's input or result),
  `invoices:read` (an invoice document), `support:read` (a ticket attachment), `customers:privacy` (a data export). A file that no record
  uses yet needs `kyc:read` when a merchant uploaded it and `customers:read` when a customer did; the public pictures of listings and
  payment methods need only `files:read`. Every download of an identity document writes an audit row under the merchant, and of a payment
  receipt under the payment, also when the file is opened from a support ticket (`GET /admin/support-tickets/:id/files/:fileId`, which keeps
  its `support:read` permission): both routes apply one rule, the list of audited kinds of file.
- **Customers' contact details in staff answers.** Outside the Customers pages, a staff answer shows a storefront customer's email address
  masked (the first two characters, three bullets and the domain: the console's own mask, applied also to an address the console would
  leave whole, such as one with a single character before the "@") unless the caller holds `customers:read`. A customer's name never falls
  back to the full address in these answers, and the live ticket updates carry the address masked. The list searches of these pages do not
  match a customer's address for callers without `customers:read`. The evidence pack that staff read shows the buyer's address masked
  in its delivery line, while the text sent to the card gateway names the buyer in full.
- **Bulk reads.** The order export also needs `reports:read`. The IMEI check log shows the digits only to holders of `risk:decide`; others
  read the stored mask (the TAC and bullets).

**Consequences.**
- Roles built from coarse permissions lose these actions until they are given the second permission; the console shows the server's
  refusal. The development seed's roles keep them through their area wildcards, except that the Support role no longer opens payment
  receipts, invoice documents and dispute evidence, no longer exports orders and reads IMEI checks masked, and the Read only role reads
  IMEI checks masked.
- No route, permission, response shape or error code is added; the template routes list `LOCKED`, and the route descriptions name the
  second permissions and the masking.
- One notification event (`customer.security_notice`) and its default template are added; the merchant's security notice gains a sentence
  for an email change. A notice about an email change names the address it went to, which the notification log shows masked.
- A template of a link email that holds another web address, an image or another tag outside the list is no longer used, and neither is the
  template of a security email that carries a `style` or `hidden` attribute or keeps its placeholder only inside a tag or a comment: the
  shipped text goes out until the template is changed.

**Not part of this decision:** re-authentication before these actions, approval by a second person, masking delivered codes and costs in
the order views, and the labels that earlier audit rows hold. Also left as they are: customers' addresses in the labels of new audit rows;
the stored invoice and dispute evidence PDFs; IMEIs in the risk queue and the order views; a ticket attachment that a merchant attached
from its own uploads, which opens through the ticket route with `support:read` (and leaves the audit row when it is an identity document or a payment proof); and the file download's audit row, which a GET writes
without an origin check (the console fetches files with credentials, and an origin check would stop its file links in a development
setup). Holding an email change until the old address confirms it is a later change.
