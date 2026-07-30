# Field Assist uses the current Pi ModelRuntime

Field Assist calls the current Dano session's package-root Pi `ModelRuntime`
with the current model identity. `ModelRuntime` remains the authority for the
provider and authentication configuration and owns provider-level retry.

Dano retains only the Field Assist product rules: generation and polishing
prompts, secret preflight, output normalization, semantic-invalid-output retry,
and browser error projection. The single provider-attempt deadline is expressed
as an `AbortSignal` passed through Pi's public request options. Each request
carries its own prompt, deadline signal, and result, so concurrent fields remain
isolated.

Field Assist does not create an `AgentSession`, `SessionManager`,
`SettingsManager`, or session file. It does not write to the main Assistant
Turn's transcript, queue, thinking, tool, compaction, or JSONL state. Queue
single-item editing/cancellation and the in-process RPC/Extension UI bridge
remain the deferred exceptions defined by the parent runtime specification.
