# ADR 0006: Use openid-client for the OAuth confidential client

Status: Accepted
Date: 2026-08-11

## Context

Dano needs one configured OAuth 2.0 confidential client that performs the
Authorization Code exchange, obtains the authenticated identity, and later can
refresh or revoke provider credentials. The provider contract has been verified
to ignore PKCE, so Dano must not claim or rely on PKCE as a security boundary.

The considered Node.js implementations were `openid-client`, its lower-level
protocol dependency `oauth4webapi`, and Arctic. `oauth4webapi` supports the
required protocols but would leave more authorization-response and token
processing choreography in Dano. Arctic primarily provides provider-oriented
connectors. `openid-client` provides a smaller application interface over
Authorization Code, refresh, revocation, and protected-resource requests, and
supports known server metadata without requiring provider discovery.

## Decision

Use `openid-client` behind the OAuth Provider Adapter seam. Configure one set of
authorization, token, and identity endpoints and authenticate the confidential
client with its client secret. The adapter receives the callback `code`, the
atomically consumed expected `state`, and the fixed redirect URI. It returns
only an External Identity and Provider Credential.

Do not send PKCE parameters or a code verifier. Dano's verified security
controls for this provider contract are the confidential-client secret and a
short-lived, browser-bound, one-time state. Production provider endpoints remain
subject to `openid-client`'s HTTPS enforcement.

## Consequences

- OAuth response and token processing stays in a maintained implementation
  instead of being copied into Dano.
- Provider response mapping remains inside the adapter; Dano core sees no
  provider-private identity fields.
- Each successful exchange creates an opaque Dano Login Session with its own
  AEAD-encrypted Provider Credential.
- A future provider contract that implements PKCE can add it inside the adapter,
  but the current implementation does not represent PKCE as active protection.

## Evidence

- [`openid-client` official feature and Node.js support matrix](https://github.com/panva/openid-client)
- [`oauth4webapi` official feature list and low-level OAuth example](https://github.com/panva/oauth4webapi)
- [Arctic official provider-oriented documentation](https://arcticjs.dev/)
