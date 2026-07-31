import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSessionMock } = vi.hoisted(() => ({
  createAgentSessionMock: vi.fn(),
}));

vi.mock("../detached-session.js", () => ({
  createDetachedAgentSessionRuntime: async (...args: unknown[]) => {
    const created = await createAgentSessionMock(...args);
    let rebindSession:
      | ((session: typeof created.session) => Promise<void>)
      | undefined;
    return {
      runtime: {
        session: created.session,
        setRebindSession: vi.fn(callback => {
          rebindSession = callback;
        }),
        fork: created.fork
          ? vi.fn(async (...forkArgs: unknown[]) => {
              const result = await created.fork(...forkArgs);
              await rebindSession?.(created.session);
              return result;
            })
          : vi.fn(),
        dispose: created.session.dispose,
      },
      disposeDanoLlmResilience: created.disposeDanoLlmResilience,
    };
  },
}));

import { DetachedSessionRegistry } from "../session-registry.js";

const roots: string[] = [];

function createRegistry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-session-registry-"));
  roots.push(root);
  return { registry: new DetachedSessionRegistry(root), root };
}

function createRunningSession(registry: DetachedSessionRegistry, root: string) {
  const handle = registry.createSession({ cwd: root, sessionDir: root });
  const calls: string[] = [];
  const providerController = new AbortController();
  const toolController = new AbortController();
  const retryController = new AbortController();
  const waitForAbort = (signal: AbortSignal) =>
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  const requestProvider = vi.fn(() => waitForAbort(providerController.signal));
  const executeTool = vi.fn(() => waitForAbort(toolController.signal));
  const waitForRetryDelay = vi.fn(() => waitForAbort(retryController.signal));
  const abortRetry = vi.fn(() => {
    calls.push("abortRetry");
    retryController.abort();
  });
  const abort = vi.fn(async () => {
    calls.push("abort");
    retryController.abort();
    providerController.abort();
    toolController.abort();
  });
  const session = {
    sessionFile: handle.sessionPath,
    sessionId: "detached-session",
    isStreaming: true,
    abort,
    abortRetry,
    bindExtensions: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
    prompt: requestProvider,
    sessionManager: handle.getSessionManager(),
  };
  const disposeDanoLlmResilience = vi.fn();
  createAgentSessionMock.mockResolvedValueOnce({
    session,
    disposeDanoLlmResilience,
  });
  return {
    handle,
    abort,
    abortRetry,
    calls,
    requestProvider,
    executeTool,
    waitForRetryDelay,
    disposeDanoLlmResilience,
    disposeSession: session.dispose,
  };
}

beforeEach(() => {
  createAgentSessionMock.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("DetachedSessionRegistry terminal viewer teardown", () => {
  async function bindRunningSession(
    registry: DetachedSessionRegistry,
    running: ReturnType<typeof createRunningSession>,
  ) {
    await registry.bindViewer(running.handle.sessionPath, {
      clientId: "client-a",
      uiContext: {} as never,
    });
    await registry.ensureSession(running.handle.sessionPath);
  }

  it("aborts an in-flight provider request when its final viewer is destroyed", async () => {
    const { registry, root } = createRegistry();
    const running = createRunningSession(registry, root);
    await bindRunningSession(registry, running);
    const requestResult = running.requestProvider().catch(error => error);

    await registry.destroyViewer(running.handle.sessionPath, "client-a");

    await expect(requestResult).resolves.toMatchObject({ name: "AbortError" });
    expect(running.requestProvider).toHaveBeenCalledTimes(1);
    expect(running.executeTool).not.toHaveBeenCalled();
    expect(running.calls).toEqual(["abort"]);
  });

  it("aborts an executing tool when its final viewer is destroyed", async () => {
    const { registry, root } = createRegistry();
    const running = createRunningSession(registry, root);
    await bindRunningSession(registry, running);
    const toolResult = running.executeTool().catch(error => error);

    await registry.destroyViewer(running.handle.sessionPath, "client-a");

    await expect(toolResult).resolves.toMatchObject({ name: "AbortError" });
    expect(running.executeTool).toHaveBeenCalledTimes(1);
    expect(running.requestProvider).not.toHaveBeenCalled();
    expect(running.calls).toEqual(["abort"]);
  });

  it("cancels an active retry delay when its final viewer is destroyed", async () => {
    const { registry, root } = createRegistry();
    const running = createRunningSession(registry, root);
    await bindRunningSession(registry, running);
    const retryResult = running.waitForRetryDelay().catch(error => error);

    await registry.destroyViewer(running.handle.sessionPath, "client-a");

    await expect(retryResult).resolves.toMatchObject({ name: "AbortError" });
    expect(running.waitForRetryDelay).toHaveBeenCalledTimes(1);
    expect(running.calls).toEqual(["abort"]);
  });

  it("keeps a running session alive while another viewer still owns it", async () => {
    const { registry, root } = createRegistry();
    const { handle, abort, abortRetry } = createRunningSession(registry, root);

    await registry.bindViewer(handle.sessionPath, {
      clientId: "client-a",
      uiContext: {} as never,
    });
    await registry.bindViewer(handle.sessionPath, {
      clientId: "client-b",
      uiContext: {} as never,
    });
    await registry.ensureSession(handle.sessionPath);

    await registry.destroyViewer(handle.sessionPath, "client-a");
    expect(abortRetry).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();

    await registry.destroyViewer(handle.sessionPath, "client-b");
    expect(abortRetry).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("is idempotent when a viewer is destroyed repeatedly", async () => {
    const { registry, root } = createRegistry();
    const { handle, abort, abortRetry } = createRunningSession(registry, root);

    await registry.bindViewer(handle.sessionPath, {
      clientId: "client-a",
      uiContext: {} as never,
    });
    await registry.ensureSession(handle.sessionPath);

    await registry.destroyViewer(handle.sessionPath, "client-a");
    await registry.destroyViewer(handle.sessionPath, "client-a");

    expect(abortRetry).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("does not abort when a viewer only switches away", async () => {
    const { registry, root } = createRegistry();
    const { handle, abort, abortRetry } = createRunningSession(registry, root);

    await registry.bindViewer(handle.sessionPath, {
      clientId: "client-a",
      uiContext: {} as never,
    });
    await registry.ensureSession(handle.sessionPath);
    await registry.releaseViewer(handle.sessionPath, "client-a");

    expect(abortRetry).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("clears Dano Assistant Turn resources before disposing the Pi session", async () => {
    const { registry, root } = createRegistry();
    const running = createRunningSession(registry, root);
    await registry.ensureSession(running.handle.sessionPath);

    await registry.removeSession(running.handle.sessionPath);

    expect(running.disposeDanoLlmResilience).toHaveBeenCalledTimes(1);
    expect(running.disposeSession).toHaveBeenCalledTimes(1);
    expect(running.disposeDanoLlmResilience.mock.invocationCallOrder[0]).toBeLessThan(
      running.disposeSession.mock.invocationCallOrder[0],
    );
  });

  it("cleans up a runtime when initial Extension UI binding fails", async () => {
    const { registry, root } = createRegistry();
    const handle = registry.createSession({ cwd: root, sessionDir: root });
    const dispose = vi.fn();
    const disposeDanoLlmResilience = vi.fn();
    createAgentSessionMock.mockResolvedValueOnce({
      session: {
        sessionFile: handle.sessionPath,
        sessionId: "failed-bind",
        isStreaming: false,
        bindExtensions: vi.fn().mockRejectedValue(new Error("bind failed")),
        subscribe: vi.fn().mockReturnValue(() => {}),
        dispose,
        sessionManager: handle.getSessionManager(),
      },
      disposeDanoLlmResilience,
    });

    await expect(registry.ensureSession(handle.sessionPath)).rejects.toThrow(
      "bind failed",
    );
    expect(disposeDanoLlmResilience).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(handle.getRuntime()).toBeNull();
  });

  it("forks into a new handle without mutating viewers of the source handle", async () => {
    const { registry, root } = createRegistry();
    const source = createRunningSession(registry, root);
    await registry.ensureSession(source.handle.sessionPath);
    const sourcePath = source.handle.sessionPath;
    const sourceManager = source.handle.getSessionManager();
    sourceManager.appendMessage({
      role: "user",
      content: "fork me",
      timestamp: Date.now(),
    } as never);
    const entryId = sourceManager.getLeafId();
    if (!entryId) throw new Error("source entry missing");

    const cloneSession = {
      sessionFile: sourcePath,
      sessionId: sourceManager.getSessionId(),
      isStreaming: false,
      bindExtensions: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
      dispose: vi.fn(),
      sessionManager: sourceManager,
    };
    createAgentSessionMock.mockResolvedValueOnce({
      session: cloneSession,
      disposeDanoLlmResilience: vi.fn(),
      fork: vi.fn(async () => {
        const forkPath = sourceManager.createBranchedSession(entryId);
        if (!forkPath) throw new Error("fork path missing");
        cloneSession.sessionFile = forkPath;
        cloneSession.sessionManager = SessionManager.open(forkPath);
        return { cancelled: false, selectedText: "fork me" };
      }),
    });

    const result = await registry.forkSession(sourcePath, entryId);

    expect(result.cancelled).toBe(false);
    expect(result.sessionPath).not.toBe(sourcePath);
    expect(registry.getHandle(sourcePath)).toBe(source.handle);
    expect(source.handle.getSession()?.sessionFile).toBe(sourcePath);
    expect(registry.getHandle(result.sessionPath)).not.toBe(source.handle);
  });
});
