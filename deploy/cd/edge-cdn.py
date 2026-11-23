#!/usr/bin/env python3
"""Writes the Caddyfile of a server that has a CDN in front of Caddy (docs/OPERATIONS.md section 1, decision 058).

Reads the repository's deploy/Caddyfile, which is the form for a server with no CDN, and prints it with three changes:

  1. The global options trust the CDN's address ranges, and read the visitor's address from the one header the CDN writes
     itself (--header; Cloudflare: CF-Connecting-IP). A forwarded-address list is not read: the visitor can send one.
  2. Every proxy to the API and to the site writes the three forwarded headers itself: exactly that address, and the host
     and the scheme of the request as Caddy received it. Nothing a visitor sent in such a header is passed on, and
     TRUST_PROXY stays the two container addresses, with or without a CDN.
  3. The shop host keeps the visitor-country header only on requests that come from the CDN's addresses.

The script prints nothing and exits 1 when deploy/Caddyfile no longer has the lines it rewrites: change both together
(test/tooling/deploy-cd.test.ts runs it against the committed file).

Usage: edge-cdn.py --ranges <file> --header <name> [--input deploy/Caddyfile] > Caddyfile
The ranges file holds one CIDR per line; empty lines and lines that start with # are skipped.
"""
import argparse
import ipaddress
import re
import sys

TIMEOUTS = "\t\ttimeouts {\n\t\t\tread_header 10s\n\t\t\tread_body_idle 30s\n\t\t\twrite_idle 1m\n\t\t\tidle 2m\n\t\t}\n"
COUNTRY = "\trequest_header -{$GEOIP_COUNTRY_HEADER:X-Visitor-Country}\n"
UPSTREAMS = {"api:3000": 3, "site:3000": 1}


def fail(message):
    sys.stderr.write("edge-cdn.py: " + message + "\n")
    sys.exit(1)


def read_ranges(path):
    ranges = []
    with open(path, encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            text = line.strip()
            if not text or text.startswith("#"):
                continue
            try:
                ranges.append(str(ipaddress.ip_network(text, strict=True)))
            except ValueError:
                fail("%s line %d is not an address range: %s" % (path, number, text))
    if not ranges:
        fail(path + " holds no address range")
    return ranges


def main():
    parser = argparse.ArgumentParser(description="Caddyfile for a server behind a CDN")
    parser.add_argument("--ranges", required=True)
    parser.add_argument("--header", required=True)
    parser.add_argument("--input", default="deploy/Caddyfile")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*", args.header):
        fail("--header must be a header name, for example CF-Connecting-IP")
    ranges = " ".join(read_ranges(args.ranges))
    with open(args.input, encoding="utf-8") as handle:
        text = handle.read()
    if "trusted_proxies static" in text or "client_ip_headers" in text:
        fail(args.input + " already trusts a proxy: it must be the repository's file")

    if text.count(TIMEOUTS) != 1:
        fail("the timeouts block of the global options was not found once in " + args.input)
    text = text.replace(
        TIMEOUTS,
        TIMEOUTS
        + "\t\t# A CDN is in front of this server (written by deploy/cd/edge-cdn.py; do not edit this copy). Only the CDN's addresses may\n"
        + "\t\t# name the visitor, and they name it in the one header the CDN writes itself. A forwarded-address list is not read.\n"
        + "\t\t# Caddy calls the host and scheme lines of the proxies below unnecessary: keep them, they are what stops a value the CDN passed on.\n"
        + "\t\ttrusted_proxies static " + ranges + "\n"
        + "\t\tclient_ip_headers " + args.header + "\n",
    )

    for upstream, expected in UPSTREAMS.items():
        pattern = re.compile(r"^(\t+)reverse_proxy " + re.escape(upstream) + r"\n", re.M)
        text, count = pattern.subn(
            lambda match: match.group(1) + "reverse_proxy " + upstream + " {\n"
            + match.group(1) + "\theader_up X-Forwarded-For {client_ip}\n"
            + match.group(1) + "\theader_up X-Forwarded-Host {host}\n"
            + match.group(1) + "\theader_up X-Forwarded-Proto {scheme}\n"
            + match.group(1) + "}\n",
            text,
        )
        if count != expected:
            fail("expected %d plain 'reverse_proxy %s' lines in %s, found %d" % (expected, upstream, args.input, count))

    shop = text.find("{$SHOP_HOST} {")
    end = text.find("\n}\n", shop)
    at = text.find(COUNTRY, shop)
    if shop < 0 or at < 0 or at > end:
        fail("the shop host's visitor-country line was not found in " + args.input)
    text = (
        text[:at]
        + "\t@not_cdn not remote_ip " + ranges + "\n"
        + "\trequest_header @not_cdn -{$GEOIP_COUNTRY_HEADER:X-Visitor-Country}\n"
        + text[at + len(COUNTRY):]
    )
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
