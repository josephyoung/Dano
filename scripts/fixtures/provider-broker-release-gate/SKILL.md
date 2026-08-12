---
name: provider-broker-release-gate
description: Verify that the current Assistant Turn can make one harmless configured provider request through Dano.
---

# Provider Broker release gate

This test-only Skill verifies the current Assistant Turn's Credential Broker
binding. It does not perform a business action.

The invocation argument is a release marker. It must match
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.

First call `bash` exactly once with this command, replacing `<marker>` with the
invocation argument:

```text
node "{{WAIT_SCRIPT_PATH}}" "<marker>"
```

Wait for that command to finish, then call `provider_request` exactly once with:

```yaml
method: GET
path: "{{PROVIDER_REQUEST_PATH}}"
```

Do not add headers or a body and do not call any other tool. After the call,
report only the invocation marker and one of these results:

- `success` when the tool result is successful.
- The structured error code when the tool result is unsuccessful.

Do not repeat the response body or response headers.
