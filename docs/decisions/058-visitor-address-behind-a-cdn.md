# 058: Behind a CDN, the visitor's address comes from the CDN's own header

Status: accepted, 2026-11-23. Amends the "With a CDN in front" steps of decisions 050 and 055; builds on decisions 018, 045 and 053.

**Context.** The API judges requests by the visitor's address: the per-address limits, the IP rules and the console's allow-list.
Without a CDN, Caddy is the first server a visitor reaches, writes that address itself and drops whatever the visitor sent, and the API
trusts exactly Caddy and the site (`TRUST_PROXY`). With a CDN in front, Caddy sees the CDN's addresses. The runbook's first answer was
to trust the CDN's ranges in Caddy and to add them to `TRUST_PROXY`, so the API walks the forwarded-address list back to the first
address that is not a trusted one. But a CDN's published ranges are not only its proxies: other traffic leaves from them too. For a
visitor whose own address is inside those ranges, that walk does not stop at the visitor: it goes on to an entry the visitor wrote.

**Decision.**

- **The address is read from the one header the CDN writes itself**, never from a forwarded-address list, and only on connections that
  come from the CDN's ranges (Cloudflare: `CF-Connecting-IP`). On any other connection the address is the connection's own.
- **Caddy writes the forwarded headers of the API and the site itself**: exactly the address it decided, and the host and the scheme
  of the request as it received it. Nothing a visitor sent in such a header is passed on. `TRUST_PROXY` stays the two container
  addresses, with or without a CDN, and never holds a CDN's ranges.
- **The repository's `deploy/Caddyfile` stays the form with no CDN** and trusts no proxy. `deploy/cd/edge-cdn.py` writes the server's
  own copy from it, and fails when the file no longer has the lines it rewrites; a test runs it against the committed file.
- **Only the CDN reaches the web ports**: `deploy/cd/origin-firewall.sh` puts the limit where Docker's published ports are decided,
  before Docker publishes them, and closes the ports over IPv6, which the CDN does not use to reach the server.
- The visitor-country header is kept only on requests from the CDN's addresses, as before (decision 050).

**Consequences.** A server behind a CDN has a Caddyfile of its own, written by a script and never by hand, and the automatic deploys
write it again when the repository's file or the list changes. The list of the CDN's ranges is a file in the repository
(`deploy/cd/cloudflare-ips.txt`) and must follow the CDN's published list. A request that reaches the origin from one of the CDN's
ranges without passing the owner's own zone still carries a header the CDN wrote: the firewall narrows who can connect, it does not
prove which zone a request came through; the CDN's authenticated origin connections would, and are not set up.
