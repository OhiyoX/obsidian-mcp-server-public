# Encrypted upstream hop — design (2026-11-06)

## Intent, and why

The browser reaches the server through the edge proxy on `example-host` (192.0.2.55), which terminates
TLS. Behind it the chain was plaintext: `browser --TLS--> example-host --HTTP--> 192.0.2.9:18923`.
The second hop crosses the LAN, so every note body, cookie and API key travelled readable to anyone
who can capture traffic on that segment (a compromised device, a bridged container, a switch SPAN).

The request was "encrypt the transport and anything the frontend keeps". The frontend keeps almost
nothing: no Service Worker, no IndexedDB, no `sessionStorage`, and `/app`, `/auth`, `/api/web/v1|v2`,
`/publish` all answer `Cache-Control: no-store`. The only browser-side residue was the attachment
response (`private, max-age=300`), now `private, no-store`. The remaining hole is therefore the wire.

## Goals, non-goals, anti-goals

- Goal: the hop proxy -> process is encrypted and the process is authenticated to the proxy.
- Goal: the plaintext port keeps working, so a rollback is one `proxy_pass` line.
- Non-goal: end-to-end encryption of note content against the server itself. Search, index, backlinks,
  publish and Git run on plaintext in the process; encrypting past that would delete those features.
- Non-goal: TLS passthrough. It would move every HTTP policy (path whitelist, `/mcp` timeouts, body
  cap, `Cache-Control`) into Node.
- Anti-goal: a server that answers plaintext after a half-applied configuration.

## Approaches considered

- **A. TLS passthrough** (nginx `stream` + SNI). Certificate and all edge policy move into the
  process. Rejected: large, and every future edge rule becomes a code change.
- **B. Terminate TLS at the edge, re-encrypt to the process** with a private CA, verified by
  `proxy_ssl_verify`. Chosen: edge policy unchanged, one new listener, rollback is a one-line revert.
- **C. Application-layer envelope encryption** (WebCrypto per session). Protects bodies only; leaves
  cookies, paths and headers readable; new protocol revision. Rejected as more work for less coverage.

## What was decided (mine, as the builder)

- Certificates are signed by a **local private CA** kept on the NAS, not by the public ACME chain:
  the hop is internal, so a public name would tie an internal hop to public renewal.
- The plaintext port stays bound, because the container health check, in-container probes and the
  rollback path use it. Restricting it to loopback is a separate, later change.
- Verification is one-way (`proxy_ssl_verify`): the proxy authenticates the process. A client
  certificate for the proxy is not added; the segment is already inside the trusted LAN.

## What is left to the builder

- The exact certificate lifetime and rotation interval (10 years is what the NAS files use today).
- Whether the plaintext port is later bound to `127.0.0.1` only.
