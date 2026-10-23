import { afterEach, expect, it } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryAcceptanceTrace } from "../memory-acceptance-trace.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "memory-trace-")); directories.push(directory);
  const handlers = new Map<string, (event: any, ctx: any) => Promise<unknown>>();
  const records: unknown[] = [];
  registerMemoryAcceptanceTrace({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI,
    directory, record => records.push(record));
  const ctx = (sessionId: string) => ({ sessionManager: { getSessionId: () => sessionId } });
  const arm = (extra = {}) => writeFile(join(directory, "acceptance-trace.json"), JSON.stringify({
    runId: "trace-test", sessionId: "target-session", expiresAt: new Date(Date.now() + 60_000).toISOString(), ...extra,
  }), { mode: 0o600 });
  return { handlers, records, ctx, arm, directory };
}

it("records actual payload inclusion and explicit calls only for the armed session, without contents", async () => {
  const f = await fixture();
  const text = JSON.stringify({ type: "quoted_memory_data", memories: [{ text: "private form answer", source: "private-uri" }] });
  const event = { messages: [{ role: "custom", customType: "openviking-reference-data", content: text }] };
  await f.handlers.get("context_with_system")!(event, f.ctx("target-session"));
  expect(f.records).toEqual([]);
  await f.arm();
  await f.handlers.get("context_with_system")!(event, f.ctx("other-session"));
  expect(f.records).toEqual([]);
  await f.handlers.get("context_with_system")!(event, f.ctx("target-session"));
  await f.handlers.get("before_provider_request")!({ payload: { messages: [{ role: "user", content: text }] } }, f.ctx("target-session"));
  await f.handlers.get("tool_call")!({ toolName: "memory_recall", toolCallId: "call-test", input: { query: "secret query" } }, f.ctx("target-session"));
  expect(f.records).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: "provider_request", automaticMemoryMessages: 1, payloadMatchedMemoryMessages: 1 }),
    expect.objectContaining({ event: "tool_call", toolName: "memory_recall", toolCallId: "call-test" }),
  ]));
  expect(JSON.stringify(f.records)).not.toMatch(/private|secret query/);
});

it("rejects public or linked controls and stops immediately when removed", async () => {
  const f = await fixture(); await f.arm();
  const path = join(f.directory, "acceptance-trace.json");
  const event = { toolName: "memory_recall", toolCallId: "call-test" };
  await chmod(path, 0o644);
  await f.handlers.get("tool_call")!(event, f.ctx("target-session"));
  expect(f.records).toEqual([]);
  await chmod(path, 0o600);
  await f.handlers.get("tool_call")!(event, f.ctx("target-session"));
  expect(f.records).toHaveLength(1);
  await rm(path);
  await f.handlers.get("tool_call")!(event, f.ctx("target-session"));
  expect(f.records).toHaveLength(1);
  const target = join(f.directory, "linked-control.json");
  await writeFile(target, JSON.stringify({ runId: "test", sessionId: "target-session", expiresAt: new Date(Date.now() + 60000).toISOString() }), { mode: 0o600 });
  await symlink(target, path);
  await f.handlers.get("tool_call")!(event, f.ctx("target-session"));
  expect(f.records).toHaveLength(1);
});

it("caps diagnostic output without changing tool execution", async () => {
  const f = await fixture(); await f.arm();
  for (let i = 0; i < 205; i++) {
    expect(await f.handlers.get("tool_call")!({ toolName: "memory_recall", toolCallId: "call-test" }, f.ctx("target-session"))).toBeUndefined();
  }
  expect(f.records).toHaveLength(200);
});

it("does not mistake context presence for payload inclusion and stops on expiry", async () => {
  const f = await fixture(); await f.arm();
  await f.handlers.get("context_with_system")!({ messages: [{ role: "custom", customType: "openviking-reference-data", content: "memory" }] }, f.ctx("target-session"));
  await f.handlers.get("before_provider_request")!({ payload: { messages: [] } }, f.ctx("target-session"));
  expect(f.records.at(-1)).toMatchObject({ automaticMemoryMessages: 1, payloadMatchedMemoryMessages: 0 });
  const count = f.records.length;
  await f.arm({ expiresAt: new Date(Date.now() - 1).toISOString() });
  await f.handlers.get("tool_call")!({ toolName: "memory_recall", toolCallId: "call-expired" }, f.ctx("target-session"));
  expect(f.records).toHaveLength(count);
});
