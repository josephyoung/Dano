import type { OperatorSkills } from "../operator-skill-snapshot.js";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WorkerSupervisorClient } from "../worker-supervisor-client.js";
import { serveWorkerSupervisor } from "../worker-supervisor-rpc.js";
import { WorkerSupervisor, type SupervisedWorker, type WorkerSupervisorOptions } from "../worker-supervisor.js";

class Channel extends EventEmitter {
  connected = true;
  peer!: Channel;
  send(value: object, callback: (error: Error | null) => void) {
    queueMicrotask(() => { if (this.connected) this.peer.emit("message", value); callback(this.connected ? null : new Error("disconnected")); });
  }
  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.emit("disconnect");
    this.peer.connected = false;
    this.peer.emit("disconnect");
  }
}
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(close => close())); });
function harness(skills?: OperatorSkills) {
  const host = new Channel(); const root = new Channel(); host.peer = root; root.peer = host;
  const factory = vi.fn(async (_owner: string, workspace: string): Promise<SupervisedWorker> => {
    let closed = false;
    const lifetime = new AbortController();
    return { workspace, agentDir: "/private/agent", stateDir: "/private/state", worker: {
      workspace,
      async assertIsolated() { if (closed) throw new Error("CLOSED"); },
      async execute(_name, parameters, signal, update) {
        signal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
        update?.({ progress: true });
        if (parameters.wait) await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
        signal?.throwIfAborted();
        if (typeof parameters.path === "string") {
          const { readFile } = await import("node:fs/promises");
          return { value: await readFile(parameters.path, "utf8") };
        }
        return { workspace, value: parameters.value };
      },
      close: vi.fn(async () => { closed = true; lifetime.abort(); }),
    } };
  });
  const pool = new WorkerSupervisor({ maxWorkers: 8 } as WorkerSupervisorOptions, factory);
  skills?.setRevoker(paths => pool.updateResources(paths));
  const client = new WorkerSupervisorClient(host, { maxConcurrentOperations: 8, maxMessageBytes: 4096,
    startupTimeoutMs: 1000, operationTimeoutMs: 5000 });
  const server = serveWorkerSupervisor(pool, root, { maxConcurrentOperations: 8, maxMessageBytes: 4096 }, skills);
  cleanup.push(async () => { client.close(); await server.close(); });
  return { client, factory, host, pool };
}
const user = (id: string) => ({ user: { id }, folderPath: `/users/${id}` });

it("prepares a resolved user's workspace over IPC without acquiring a worker", async () => {
  const { client, factory, pool } = harness();
  const prepare = vi.spyOn(pool, "prepare").mockResolvedValue(undefined);
  await client.prepareWorkspace(user("alice"), "/users/alice/workspaces/default");
  expect(prepare).toHaveBeenCalledWith("alice", "/users/alice/workspaces/default");
  expect(factory).not.toHaveBeenCalled();
  await expect(client.prepareWorkspace(user("alice"), "/users/bob/workspaces/default")).rejects.toThrow("OWNER_MISMATCH");
  await expect(client.prepareWorkspace(user("alice"), "/users/alice/workspaces/default/nested")).rejects.toThrow("OWNER_MISMATCH");
  expect(prepare).toHaveBeenCalledOnce();
});

it("binds profiles to server users, shares startup, and refuses foreign workspaces", async () => {
  const { client, factory } = harness();
  const alice = await client.profile(user("alice"), { trustedSkillPaths: [] });
  const bob = await client.profile(user("bob"), { trustedSkillPaths: [] });
  const [a, repeated] = await Promise.all([
    alice.resolveWorker("/users/alice/workspaces/default"), alice.resolveWorker("/users/alice/workspaces/default"),
  ]);
  expect(factory).toHaveBeenCalledTimes(2);
  await repeated.assertIsolated();
  await expect(alice.resolveWorker("/users/bob/workspaces/default")).rejects.toThrow("OWNER_MISMATCH");
  const updates: unknown[] = [];
  expect(await a.execute("read", { value: "own" }, undefined, value => updates.push(value)))
    .toEqual({ workspace: "/users/alice/workspaces/default", value: "own" });
  expect(updates).toEqual([{ progress: true }]);
  await alice.dispose!();
  await expect(a.execute("read", {})).rejects.toThrow("UNAVAILABLE");
  const b = await bob.resolveWorker("/users/bob/workspaces/default");
  await b.assertIsolated();
  await bob.dispose!();
});

it("propagates cancellation across both IPC directions", async () => {
  const { client } = harness();
  const profile = await client.profile(user("alice"), { trustedSkillPaths: [] });
  const worker = await profile.resolveWorker("/users/alice/workspaces/default");
  const abort = new AbortController();
  await expect(worker.execute("bash", { wait: true }, abort.signal, () => abort.abort())).rejects.toThrow("CANCELLED");
  await worker.assertIsolated();
  await profile.dispose!();
});

it("invalidates profiles after parent disconnect and never falls back to local execution", async () => {
  const { client, host } = harness();
  const profile = await client.profile(user("alice"), { trustedSkillPaths: [] });
  const worker = await profile.resolveWorker("/users/alice/workspaces/default");
  host.disconnect();
  await expect(worker.assertIsolated()).rejects.toThrow("UNAVAILABLE");
  await expect(profile.resolveWorker("/users/alice/workspaces/another")).rejects.toThrow("UNAVAILABLE");
});

it("revokes active calls across two live IPC profiles and rejects stale queued calls without replay", async () => {
  const { mkdtemp, realpath, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { snapshotOperatorSkills } = await import("../operator-skill-snapshot.js");
  const root = await realpath(await mkdtemp(join(tmpdir(), "skills-ipc-")));
  const source = join(root, "skills"), installation = join(root, "installation");
  await mkdir(join(source, "example"), { recursive: true }); await mkdir(installation);
  const document = (body: string) => `---\nname: example\ndescription: Example\n---\n${body}\n`;
  await writeFile(join(source, "example/SKILL.md"), document("A"));
  const skills = await snapshotOperatorSkills(installation, [source], process.getuid!());
  const h = harness(skills);
  try {
    const alice = await h.client.profile(user("alice"), { trustedSkillPaths: [] });
    const bob = await h.client.profile(user("bob"), { trustedSkillPaths: [] });
    let revision = (await alice.operatorSkills!.current()).revision;
    const old = join(skills.paths[0]!, "example/SKILL.md");
    const a = await alice.resolveWorker("/users/alice/workspaces/default", () => revision);
    const b = await bob.resolveWorker("/users/bob/workspaces/default", () => revision);
    expect(await a.execute("read", { path: old })).toEqual({ value: document("A") });
    const started: Promise<void>[] = [];
    let observed = 0;
    const waits = [a, b].map(worker => {
      let resolve!: () => void;
      started.push(new Promise<void>(done => { resolve = done; }));
      const pending = worker.execute("bash", { wait: true }, undefined, () => { observed++; resolve(); });
      return expect(pending).rejects.toThrow("OPERATOR_SKILLS_CHANGED");
    });
    await Promise.all(started);
    await writeFile(join(source, "example/SKILL.md"), document("B"));
    await skills.refresh();
    await Promise.all(waits);
    expect(observed).toBe(2);
    await expect(a.execute("bash", { value: "old queued command" })).rejects.toThrow("OPERATOR_SKILLS_CHANGED");
    revision = (await alice.operatorSkills!.current()).revision;
    await expect(a.execute("read", { path: old })).rejects.toThrow("SUPERVISOR_OPERATION_FAILED");
    const next = join(skills.paths[0]!, "example/SKILL.md");
    expect(await a.execute("read", { path: next })).toEqual({ value: document("B") });
    expect(await b.execute("read", { path: next })).toEqual({ value: document("B") });
    expect(h.factory).toHaveBeenCalledTimes(4);
    await rm(join(source, "example"), { recursive: true });
    await skills.refresh();
    revision = (await alice.operatorSkills!.current()).revision;
    await expect(b.execute("read", { path: next })).rejects.toThrow("SUPERVISOR_OPERATION_FAILED");
  } finally {
    h.client.close(); await h.pool.close(); await skills.cleanup(); await rm(root, { recursive: true, force: true });
  }
});
