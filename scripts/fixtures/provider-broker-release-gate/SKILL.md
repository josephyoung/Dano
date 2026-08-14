---
name: provider-broker-release-gate
description: Verify that the current Assistant Turn can make one harmless configured provider request through Dano.
---

# Provider Broker release gate

This test-only Skill verifies the current Assistant Turn's Credential Broker
binding. It does not perform a business action.

The invocation argument is a gate marker. It must match
`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.

First call `ask_user_question` exactly once with this canonical single-choice
question, replacing `<marker>` with the invocation argument:

```yaml
question: "Continue provider release gate <marker>?"
inputType: radio
options:
  - id: continue
    label: Continue
  - id: stop
    label: Stop
required: true
default: "continue"
```

If the answer is `continue`, call `provider_request` exactly once with:

```yaml
method: GET
path: "{{PROVIDER_REQUEST_PATH}}"
```

If the answer is not `continue`, stop without calling `provider_request`. Do not
add headers or a body and do not call any other tool. After the provider call,
report only the invocation marker and one of these results:

- `success` when the tool result is successful.
- The structured error code when the tool result is unsuccessful.

Do not repeat the response body or response headers.
