# Model gateway TLS diagnostics

Load this reference when a deployed Dano container reaches DNS but model sessions end in `Connection error`, especially with `SELF_SIGNED_CERT_IN_CHAIN`, private PKI, or multiple external services using different roots.

## Isolate the failing layer

Prove each layer in order:

1. Resolve the gateway hostname inside the running app container.
2. Perform an HTTPS request without credentials. A TLS-chain error means authentication, rate limits, model configuration, and Bridge code have not run yet.
3. Inspect the gateway certificate chain without printing request credentials or model payloads.
4. After installing trust, repeat the unauthenticated request. An expected `401` or provider-defined authentication error proves DNS, TCP, TLS, and HTTP now work.
5. Use the container's existing model configuration for one minimal real request. Require HTTP 200 and a non-empty choice/result while reporting only status, result count, and timing.
6. Confirm the browser can complete a real model turn. A direct gateway 200 supports diagnosis but does not replace the browser acceptance gate.

Session JSONL entries repeatedly ending in `Connection error` support the TLS diagnosis but are not proof of recovery.

## Build a trustworthy CA bundle

1. Retrieve the presented chain with a standard TLS inspection tool such as `openssl s_client -showcerts`.
2. Identify the actual trust anchor. Verify certificate subjects, issuers, validity, fingerprints, basic constraints, and the chain before trusting it. Do not treat an arbitrary leaf certificate as a root.
3. If OA and the model gateway require different private roots, combine the verified PEM certificates into one temporary bundle. `NODE_EXTRA_CA_CERTS` accepts one file path, so the bundle is the single source of trust for the app process.
4. Store the bundle under the isolated run root, mount it read-only into the app container, and point `NODE_EXTRA_CA_CERTS` at the container path.
5. Recreate the app container after changing the bundle or environment. Node reads extra CA configuration at process startup; a file or Compose edit alone does not update the running process.
6. Preserve the rest of the deployment override, including OAuth endpoints, provider headers, runtime mounts, and nginx settings. Inspect the effective Compose configuration before recreation.

Keep TLS verification enabled. A verified private root bundle is the compatibility mechanism; `NODE_TLS_REJECT_UNAUTHORIZED=0` is not.

## Acceptance evidence

Record this transition without sensitive values:

- before: hostname resolves, HTTPS fails with a stable TLS-chain error;
- after CA bundle: unauthenticated HTTPS reaches the gateway and returns the expected authentication status;
- authenticated probe: one real model request returns HTTP 200 with a non-empty result and bounded timing;
- rendered browser: the user retries and receives a completed assistant answer.

If the first three pass but the browser still fails, return to Bridge/SSE/session diagnosis. If the unauthenticated probe still fails at TLS, do not investigate model credentials or rate limits yet.
