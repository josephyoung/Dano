---
name: dano-podman-browser-acceptance
description: Deploy Dano locally through its real Podman/Compose release path and complete API, SSE, OAuth, upload, model-tool, and Codex in-app Browser acceptance. Use when a user asks to deploy or test Dano locally with Podman, validate shipped container/runtime behavior, connect a local Dano stack to an external OAuth/OA provider, diagnose a container-only authentication failure, or leave a verified local stack running for hands-on testing.
---

# Dano Podman Browser Acceptance

Use the shipped container path and real browser behavior as the authority. Do not substitute unit tests, fake providers, `curl`, or `smoke:deploy` for a required browser/provider release gate.

## Establish the acceptance contract

1. Read the repository `AGENTS.md`, deployment instructions, root scripts, Compose file, nginx config, and current authentication configuration.
2. Record which outcomes are required: startup, anonymous chat, OAuth login, callback return, username display, transcript preservation, logout, upload/model read, or model-triggered bash.
3. Determine whether the user wants the stack left running for manual testing. Cleanup is the default only when the user did not ask to keep it.
4. Treat the real external provider as a release gate whenever OAuth/OA integration is in scope. Fake-provider tests prove deterministic protocol handling, not real compatibility.

## Prepare an isolated deployment

1. Verify the Podman machine, current containers, occupied ports, and available disk before mutation.
2. Create a dedicated run root with `mktemp -d` under `/private/tmp`. Place runtime data, generated certificates, Compose overrides, and temporary env files there. Never use the checkout as `DANO_RUNTIME_DIR` or workspace.
3. Set secret-bearing files to mode `0600`. Do not print, commit, or place real provider addresses, Client Secrets, tokens, cookies, raw User IDs, or private payloads in issues, PRs, fixtures, command output, or browser evidence.
4. Build the real image from the current source with a unique temporary tag. Start it through the repository Compose/deploy path, not an approximate `podman run` command.
5. On macOS, if `podman ps` works but Compose reports a machine lock or missing machine, rerun the same Compose operation on the permitted/escalated path. Do not change Dano code to compensate for blocked Podman metadata.

## Configure HTTPS and an external provider

1. Use one exact callback URI and configure Dano, the provider client, nginx, and browser to agree on scheme, host, port, and path.
2. Keep server-to-server TLS validation enabled. If a test provider is HTTP-only while Dano requires HTTPS, use a temporary loopback TLS relay with a generated local certificate and mount only its CA into the app via `NODE_EXTRA_CA_CERTS`. Never set `NODE_TLS_REJECT_UNAUTHORIZED=0`.
3. Bind a temporary relay to loopback unless the Podman VM must reach it. When VM access is required, expose only the minimum port, use an explicit host-gateway mapping, and verify the relay cannot proxy arbitrary origins.
4. Verify the provider's real token client-auth method before starting the browser flow. Do not assume `client_secret_post`, Basic auth, PKCE, tenant headers, response wrapping, identity shape, refresh, or revocation behavior.
5. Model provider-required static headers as generic request headers. Never turn provider-specific fields into Dano User, tenant, or business concepts.
6. Read [OAuth provider diagnostics](references/oauth-provider-diagnostics.md) before changing adapters, adding a relay, or interpreting a real login failure.
7. When model calls report `Connection error`, `SELF_SIGNED_CERT_IN_CHAIN`, or another TLS-chain failure, read [Model gateway TLS diagnostics](references/model-gateway-tls.md) before changing credentials, Bridge code, DNS, or retry behavior.

## Start and prove the stack

1. Run the repository deployment smoke check immediately after startup.
2. Verify health, HTTPS, anonymous HttpOnly Cookie issuance, Client creation, SSE connection, command response, and disconnect through the deployed nginx origin.
3. Inspect the running container facts relevant to the change: image/version, non-root UID, runtime mounts, writable runtime directory, trusted CA, configured endpoint origins, and enabled tools. Report presence or fingerprints, never secret values.
4. Open the deployed origin in the Codex in-app Browser. Reuse or reclaim the existing tab when possible; close temporary tabs after use.
5. For authentication, prove the complete user-visible chain:
   - select Login from the existing top-left menu;
   - reach the external login/authorization surface;
   - return to a clean Dano URL;
   - see the authenticated username in the same menu;
   - recover the pre-login/latest conversation and transcript;
   - log out and obtain a usable fresh Anonymous User.
6. When deploy/runtime/Heimdall/upload behavior is in scope, additionally prove one plain chat answer, one image upload the model actually reads/describes, and one model-triggered `bash ls` result in the transcript.
7. Capture a screenshot for user-visible acceptance. A navigation timeout is not page-failure proof; inspect final URL, visible state, tab ownership, SSE, and server logs before concluding.

## Diagnose without contaminating evidence

1. Correlate browser action, nginx request, app lifecycle, provider request, and provider response by timestamp and sanitized stage.
2. For JSON wrapper providers, inspect both HTTP status and the provider's business code. HTTP 200 can still be an OAuth failure.
3. Log only method, path category, status, stable error code, timing, and response field names. Hash random identifiers only when correlation is necessary; never log their raw values.
4. Separate these stages explicitly: authorization redirect, callback state consumption, code-to-token exchange, identity fetch/validation, credential persistence, Dano Login Session creation, and browser projection.
5. Do not call the feature complete when the browser returns from the provider but token exchange or identity validation fails. Preserve the anonymous chat state and report the exact failed release gate.
6. Do not infer success from automatic provider redirect. Existing approval can skip the consent UI while the subsequent token exchange still fails.

## Handoff or cleanup

When the user wants to test manually:

1. Leave only the required app/nginx/relay/tunnel processes running.
2. Confirm the public local URL and health.
3. Keep one deliverable in-app Browser tab and close diagnostic tabs.
4. Report the exact completed and incomplete gates, plus the command needed to stop the stack later.

Otherwise:

1. Stop the temporary relay/tunnel and Compose stack.
2. Confirm no container references the temporary image.
3. Remove only the run directory, temporary image/tag, and dangling layers created by this run. Keep reusable base images.
4. Verify the checkout remains clean and the test ports are no longer listening.

## Completion checklist

- Real image built from the intended source state.
- Isolated runtime used; checkout not polluted.
- Compose/deploy path and smoke check passed.
- Required API/SSE and browser flows passed.
- Real OAuth provider passed when in scope; otherwise completion is explicitly blocked.
- No provider secret, token, cookie, raw User ID, private payload, or forbidden provider address leaked.
- Stack was either deliberately left healthy for the user or fully cleaned up.
