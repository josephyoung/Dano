import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Control = { runId: string; sessionId: string; expiresAt: string };
type RecordData = Record<string, string | number | boolean>;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Host-only, short-lived opt-in for one exact session. Never exports payloads,
 * queries, memory text, URIs, headers, or answers. Removing the control stops it. */
export function registerMemoryAcceptanceTrace(pi: ExtensionAPI, stateDirectory: string,
  emit: (record: RecordData) => void = record => console.info("[memory-acceptance] " + JSON.stringify(record))): void {
  let sequence = 0;
  let request = 0;
  let activeKey = "";
  let memoryDigests: string[] = [];
  let contextObserved = false;
  let emitted = 0;
  async function control(ctx: ExtensionContext): Promise<Control | undefined> {
    let file;
    try {
      file = await open(join(stateDirectory, "acceptance-trace.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 2048) return;
      const bytes = await file.readFile();
      if (bytes.length > 2048) return;
      const value = JSON.parse(bytes.toString("utf8")) as Control;
      if (!value || typeof value.runId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.runId)
        || typeof value.sessionId !== "string" || value.sessionId !== ctx.sessionManager.getSessionId()
        || typeof value.expiresAt !== "string") return;
      const remaining = Date.parse(value.expiresAt) - Date.now();
      if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 60 * 60 * 1000) return;
      const key = JSON.stringify([value.runId, value.sessionId, value.expiresAt]);
      if (activeKey !== key) {
        activeKey = key; sequence = 0; request = 0; memoryDigests = []; contextObserved = false; emitted = 0;
      }
      return value;
    } catch { return; }
    finally { await file?.close().catch(() => {}); }
  }
  function record(c: Control, data: RecordData) {
    if (emitted++ >= 200) return;
    try { emit({ runId: c.runId, sessionId: c.sessionId, sequence: ++sequence,
      timestamp: new Date().toISOString(), request, ...data }); } catch { /* Diagnostics cannot break chat. */ }
  }
  pi.on("context_with_system", async (event, ctx) => {
    const c = await control(ctx); if (!c) { memoryDigests = []; contextObserved = false; return; }
    memoryDigests = event.messages.flatMap(message => message.role === "custom"
      && message.customType === "openviking-reference-data" && typeof message.content === "string"
      ? [digest(message.content)] : []);
    contextObserved = true;
    record(c, { event: "context", automaticMemoryMessages: memoryDigests.length });
  });
  pi.on("before_provider_request", async (event, ctx) => {
    const c = await control(ctx); if (!c) return;
    request++;
    // Walk only the armed request. Match complete text values, never print them.
    const found = new Set<string>();
    const pending: unknown[] = [event.payload];
    const seen = new Set<object>();
    let nodes = 0, bytes = 0;
    while (pending.length && nodes++ < 10000 && bytes <= 4 * 1024 * 1024) {
      const value = pending.pop();
      if (typeof value === "string") {
        bytes += Buffer.byteLength(value);
        if (bytes <= 4 * 1024 * 1024) found.add(digest(value));
      } else if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value); pending.push(...Object.values(value));
      }
    }
    record(c, { event: "provider_request", contextObserved, automaticMemoryMessages: memoryDigests.length,
      payloadMatchedMemoryMessages: memoryDigests.filter(hash => found.has(hash)).length,
      inspectionComplete: pending.length === 0 && bytes <= 4 * 1024 * 1024 });
  });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "memory_recall" && event.toolName !== "ask_user_question") return;
    const c = await control(ctx); if (!c) return;
    record(c, { event: "tool_call", toolName: event.toolName, toolCallId: event.toolCallId });
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "memory_recall" && event.toolName !== "ask_user_question") return;
    const c = await control(ctx); if (!c) return;
    record(c, { event: "tool_result", toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError });
  });
}
