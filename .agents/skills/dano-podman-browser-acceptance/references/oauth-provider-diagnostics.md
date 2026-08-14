# OAuth provider diagnostics

Load this reference only for real OAuth/OA configuration or failures.

## Contract discovery

Verify from provider documentation, source, or a sanitized real request:

- authorization and token endpoint paths;
- exact redirect URI matching;
- supported grants and scopes;
- token endpoint client authentication;
- PKCE behavior;
- required generic headers;
- HTTP status versus JSON business-code semantics;
- token response wrapping and standard field names;
- identity endpoint authentication and minimal stable identity field;
- refresh-token rotation and identity revalidation;
- revocation transport and cascading behavior.

Do not encode provider business fields into Dano. Normalize only the transport contract into the existing generic `ExternalIdentity` and provider credential seams.

## Safe observability

Prefer a temporary fixed-origin relay only when it is necessary to bridge local TLS or capture sanitized protocol facts. It must:

- accept one configured upstream origin;
- reject open-proxy behavior and redirects to unexpected origins;
- validate certificates and hostnames;
- redact authorization, cookies, query codes, state, tokens, secrets, and identities;
- log timestamps, method, path category, status, stable business code, timing, and response key names only;
- use `no-store` and `no-referrer` on temporary redirects or callback pages;
- remain outside production code and be deleted with the run unless it exposes a proven reusable product requirement.

## Failure matrix

### Immediate return from authorization

Do not assume success or failure. A provider can auto-approve a previously granted scope and immediately return. Continue through token exchange, identity validation, Login Session persistence, and browser authentication projection.

### HTTP 200 with login failure

Inspect the JSON wrapper's business code and the shape of `data`. Many legacy providers return protocol failures with HTTP 200. Preserve only the stable error code in evidence.

### Authorization code expired

1. Confirm a new state transaction and a new browser authorization attempt.
2. Measure authorization-to-token latency without logging code or state.
3. Compare host, container, provider HTTP Date, and—when accessible—provider application/database time.
4. Confirm the provider's configured code TTL from authoritative source.
5. If a fresh code is rejected well within TTL, treat the real provider gate as failed. Likely causes include stale-code reuse, load-balanced instances with inconsistent clocks/timezones, or database/JDBC time conversion.
6. Logging out of provider SSO distinguishes cached/automatic authorization from a persistent backend fault, but it is not itself a fix.
7. Dano cannot safely convert a provider-rejected authorization code into a token. Do not hide the failure with infinite authorization retries or a forged local success.

### Token endpoint authentication mismatch

Compare the actual provider contract against the OAuth library configuration. Use the library's supported client-auth mechanism. Do not add a static `Authorization` header to all provider requests; it can collide with identity Bearer authentication and leak credentials across endpoints.

### Provider requires a static routing header

Pass it through the generic provider-header configuration and verify presence only. Do not expose the value or introduce provider-specific tenant/business modeling into Dano.

### Callback succeeds but conversation disappears

Verify the anonymous-owner transfer completes before issuing the Login Session, then ensure the browser lists and opens the most recent existing session before creating a new one. Prove the recovered transcript in the rendered browser.

## Evidence hierarchy

Use evidence in this order:

1. rendered in-app Browser behavior;
2. real provider request/response stages with sanitized codes;
3. Dano public HTTP/SSE behavior and persisted server-owned state;
4. deterministic fake-provider integration tests;
5. unit tests and static configuration inspection.

Lower levels support diagnosis but do not replace a missing higher-level release gate.
