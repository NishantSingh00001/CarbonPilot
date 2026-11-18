# Security Review — CarbonPilot

CarbonPilot's frontend (`index.html` + `app.js`) is static and renders all
API-derived data (grid demand, schedule, timestamps) via `textContent`, never
`innerHTML` with that data — confirmed no free-text user input reaches the
DOM unescaped. There are two backend variants: a local Python stdlib server
(`server.py`, bound to `127.0.0.1` only) for local development, and a public
Netlify Function (`netlify/functions/api.js`) used on the deployed site; both
proxy the public India Electricity Data API and run the same seasonal-naive
forecast + dynamic-programming scheduler. Neither handles secrets, auth, or
personal data — the only "input" is a Thane-area demand/compute scheduling
toy problem.

## 20-point pen-test checklist

| # | Check | Applicable? | Notes |
|---|-------|-------------|-------|
| 1 | HTTP/2 Rapid Reset (CVE-2023-44487) | N/A | `server.py` is a local-only dev server; the deployed endpoint runs on Netlify's managed function runtime, not a custom HTTP/2 server this repo controls. |
| 2 | bcrypt 72-byte truncation | N/A | No password hashing. |
| 3 | SAML signature bypass (CVE-2024-45409) | N/A | No SAML/SSO. |
| 4 | nOAuth | N/A | No OAuth/auth of any kind. |
| 5 | GraphQL alias batching | N/A | No GraphQL. |
| 6 | TOTP replay (RFC 6238 §5.2) | N/A | No TOTP/2FA. |
| 7 | ReDoS | No | No user-supplied-pattern regexes in either backend or the frontend. |
| 8 | JWT algorithm confusion | N/A | No JWTs. |
| 9 | HTTP request smuggling | N/A | `server.py` is `127.0.0.1`-only via Python's stdlib `ThreadingHTTPServer`; the Netlify Function runs behind Netlify's own edge, not a custom origin server. |
| 10 | Web cache poisoning | N/A | Both backends set `Cache-Control: no-store` on their JSON responses; no other cacheable server output exists. |
| 11 | Spoofed X-Forwarded-For | N/A | Neither backend reads or trusts any client IP header. |
| 12 | Postgres views bypassing RLS | N/A | No database. |
| 13 | `Math.random()` for security tokens | No | `Math.random()` is not used anywhere in this repo (the scheduler is a deterministic DP search, not randomized). |
| 14 | Timing attacks on secret comparison | N/A | No secrets/credentials are compared anywhere. |
| 15 | Padding oracle | N/A | No encryption/decryption. |
| 16 | Server-side prototype pollution | No | Both `/api/schedule` handlers read only the fixed fields `refresh`/`max_delay_hours`/`avoidance_priority` off the parsed body, each coerced with `Number()`/`float()` and clamped (`min`/`max`) before use — neither spreads or deep-merges the parsed JSON itself. |
| 17 | Server-side template injection | N/A | No templating engine. |
| 18 | XXE | N/A | No XML parsing (JSON only). |
| 19 | Cross-site WebSocket hijacking | N/A | No WebSockets. |
| 20 | Unicode username normalization | N/A | No usernames/accounts. |

## Findings outside the 20-point list

**The public Netlify Function (`netlify/functions/api.js`) has open CORS and
no rate limiting or request-size cap, while the local Python server is more
restrictive.** `netlify/functions/api.js:21` sets
`access-control-allow-origin: '*'` on every response, and `/api/schedule`
(`:206`) does `JSON.parse(event.body || '{}')` directly with no length check
before parsing, then runs the dynamic-programming scheduler and two upstream
fetches to the India Electricity Data API per request — all with no rate
limit. By contrast, `server.py`'s equivalent (`do_POST`, local-only anyway)
caps the request body to 4096 bytes before reading
(`min(int(self.headers.get("Content-Length","0")), 4096)`). The computation
itself is small and the upstream calls are cached for 3 minutes
(`CACHE_MS`), so the practical cost of abuse is modest, but as deployed the
endpoint would let any origin trigger unlimited scheduler runs and upstream
fetch attempts — the same uncapped-public-endpoint pattern seen in a few of
this author's other serverless repos. Suggested fix: add a per-IP/time-window
rate limit and a request-body size cap to `netlify/functions/api.js`,
mirroring what `server.py` already does. Not applied — pending your
approval.
