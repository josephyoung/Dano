# Scoped memory acceptance evidence

Automatic recall modifies a temporary context, not the persisted transcript.
For an explicitly authorized acceptance run, an operator may create
`acceptance-trace.json` inside that user's existing host-owned memory state
directory. The worker cannot access this directory. It is absent by default.

```json
{
  "runId": "unique-acceptance-run",
  "sessionId": "exact-new-acceptance-session-id",
  "expiresAt": "ISO timestamp less than one hour in the future"
}
```

The control must be a private regular file, owned by the app UID, with one hard
link. Use the session ID returned by the newly created browser session, never a
scan of unrelated session files. Only that exact session emits
`[memory-acceptance]` JSON records. Remove the control after the run; expiration
also stops recording. At most 200 events are emitted by each registered session
extension for a control revision. Missing or invalid control disables tracing.

Records include run/session ID, sequence, time, provider request ordinal,
automatic memory message count, and the number of complete memory texts matched
in the serialized provider payload. Hashes are used internally for comparison
and are not exported. Tool call/result records contain only tool name, call ID
and error boolean for `memory_recall` and `ask_user_question`.

No text, answer, query, URI, headers or credentials are logged. Read only records
with the exact run and session IDs. The diagnostic does not change model input,
tool arguments, recall policy or defaults. It uses Pi's existing context and
provider-request hooks rather than replacing transport or adding a proxy.

For a complete request, require `contextObserved=true`,
`inspectionComplete=true`, and compare `payloadMatchedMemoryMessages` with
`automaticMemoryMessages`. A positive match proves automatic data was in that
provider request. Correlate request order and explicit `memory_recall` call/result
events with the form call. Both paths may occur in one turn. This proves data
availability and tool execution, not which source causally determined the
model's choice when both sources are present. A missing match or incomplete
inspection is inconclusive, never evidence that the model had no memory.

This changes observability only; the `ask_user_question` capabilities, defaults,
parameters and guide contract are unchanged.
