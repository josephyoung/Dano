import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createAgentSessionFromServicesMock,
  createAgentSessionRuntimeMock,
  createAgentSessionServicesMock,
  createCurlToolMock,
  createEditToolDefinitionMock,
  createReadToolDefinitionMock,
  createWriteToolDefinitionMock,
} = vi.hoisted(() => ({
  createAgentSessionFromServicesMock: vi.fn(),
  createAgentSessionRuntimeMock: vi.fn(),
  createAgentSessionServicesMock: vi.fn(),
  createCurlToolMock: vi.fn(),
  createEditToolDefinitionMock: vi.fn(),
  createReadToolDefinitionMock: vi.fn(),
  createWriteToolDefinitionMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<
    typeof import("@earendil-works/pi-coding-agent")
  >("@earendil-works/pi-coding-agent");

  return {
    ...actual,
    createAgentSessionFromServices: createAgentSessionFromServicesMock,
    createAgentSessionRuntime: createAgentSessionRuntimeMock,
    createAgentSessionServices: createAgentSessionServicesMock,
    createEditToolDefinition: createEditToolDefinitionMock,
    createReadToolDefinition: createReadToolDefinitionMock,
    createWriteToolDefinition: createWriteToolDefinitionMock,
  };
});

vi.mock("../curl-tool.js", () => ({
  createCurlTool: createCurlToolMock,
}));

import { createDetachedAgentSessionRuntime } from "../detached-session.js";
import { danoVersionTool } from "../dano-version-tool.js";
import { detectWorkspaceEnvironments } from "../workspace-environment.js";

describe("detached-session", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-detached-session-"));
    createAgentSessionFromServicesMock.mockReset();
    createAgentSessionRuntimeMock.mockReset();
    createAgentSessionServicesMock.mockReset();
    createCurlToolMock.mockReset();
    createEditToolDefinitionMock.mockReset();
    createReadToolDefinitionMock.mockReset();
    createWriteToolDefinitionMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects the workspace environments exposed to the UI", () => {
    const workspaceDir = path.join(tmpDir, "sample-app");
    fs.mkdirSync(path.join(workspaceDir, ".venv", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(workspaceDir, ".envrc"), "use nix\n", "utf8");
    fs.writeFileSync(
      path.join(workspaceDir, ".venv", "bin", "activate"),
      [
        "# activate",
        "VIRTUAL_ENV_PROMPT=.venv",
        "export VIRTUAL_ENV_PROMPT",
      ].join("\n") + "\n",
      "utf8",
    );

    expect(detectWorkspaceEnvironments(workspaceDir)).toEqual([
      {
        type: "direnv",
        label: "direnv",
        detail: ".envrc",
      },
      {
        type: "python-venv",
        label: "sample-app",
        detail: ".venv/bin/activate",
      },
    ]);
  });

  it("prefers an explicit python env prompt when available", () => {
    const workspaceDir = path.join(tmpDir, "service-api");
    fs.mkdirSync(path.join(workspaceDir, ".venv", "bin"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(workspaceDir, ".venv", "pyvenv.cfg"),
      "prompt = 'api-dev'\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(workspaceDir, ".venv", "bin", "activate"),
      "# activate\n",
      "utf8",
    );

    expect(detectWorkspaceEnvironments(workspaceDir)).toEqual([
      {
        type: "python-venv",
        label: "api-dev",
        detail: ".venv/bin/activate",
      },
    ]);
  });

  it("builds custom tools for detached sessions", async () => {
    vi.useFakeTimers();
    const applyOverrides = vi.fn();
    const services = {
      settingsManager: {
        getImageAutoResize: vi.fn().mockReturnValue(false),
        getRetryEnabled: vi.fn().mockReturnValue(true),
        applyOverrides,
      },
    };
    const readToolDefinition = { name: "read" };
    const curlToolDefinition = { name: "curl" };
    const editToolDefinition = { name: "edit" };
    const writeToolDefinition = { name: "write" };
    const configuredAskUserQuestionTool = { name: "configured-question" };
    let sessionEventHandler: ((event: any) => void) | undefined;
    const setAutoCompactionEnabled = vi.fn();
    const sessionResult = {
      session: {
        sessionId: "session-123",
        setAutoCompactionEnabled,
        abort: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn((handler: (event: any) => void) => {
          sessionEventHandler = handler;
          return vi.fn();
        }),
      },
    };
    const sessionManager = { getCwd: vi.fn().mockReturnValue(tmpDir) };

    createAgentSessionServicesMock.mockResolvedValue(services);
    createReadToolDefinitionMock.mockReturnValue(readToolDefinition);
    createCurlToolMock.mockReturnValue(curlToolDefinition);
    createEditToolDefinitionMock.mockReturnValue(editToolDefinition);
    createWriteToolDefinitionMock.mockReturnValue(writeToolDefinition);
    createAgentSessionFromServicesMock.mockResolvedValue(sessionResult);
    createAgentSessionRuntimeMock.mockImplementation(
      async (factory: (options: object) => Promise<object>, options: object) => {
        const created = (await factory(options)) as { session: object };
        return {
          session: created.session,
          setBeforeSessionInvalidate: vi.fn(),
        };
      },
    );

    const result = await createDetachedAgentSessionRuntime(
      tmpDir,
      sessionManager as never,
      { askUserQuestionTool: configuredAskUserQuestionTool as never },
    );

    expect(createAgentSessionServicesMock).toHaveBeenCalledWith({
      cwd: tmpDir,
      agentDir: expect.any(String),
      resourceLoaderOptions: {
        additionalExtensionPaths: [
          expect.stringContaining("pi-heimdall/extensions/heimdall.ts"),
        ],
      },
    });
    expect(applyOverrides).not.toHaveBeenCalled();
    expect(createReadToolDefinitionMock).toHaveBeenCalledWith(tmpDir, {
      autoResizeImages: false,
    });
    expect(createCurlToolMock).toHaveBeenCalledWith(tmpDir);
    expect(createEditToolDefinitionMock).toHaveBeenCalledWith(tmpDir);
    expect(createWriteToolDefinitionMock).toHaveBeenCalledWith(tmpDir);
    expect(createAgentSessionFromServicesMock).toHaveBeenCalledWith({
      services,
      sessionManager,
      sessionStartEvent: undefined,
      noTools: "builtin",
      customTools: [
        readToolDefinition,
        curlToolDefinition,
        editToolDefinition,
        writeToolDefinition,
        danoVersionTool,
        configuredAskUserQuestionTool,
      ],
    });
    expect(result.runtime.session).toBe(sessionResult.session);
    expect(result.disposeDanoLlmResilience).toEqual(expect.any(Function));
    expect(setAutoCompactionEnabled).toHaveBeenCalledWith(true);

    const overrideCallCount = applyOverrides.mock.calls.length;
    sessionEventHandler?.({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    expect(applyOverrides).toHaveBeenCalledTimes(overrideCallCount);

    sessionEventHandler?.({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial response" }],
      },
    });
    expect(applyOverrides).toHaveBeenLastCalledWith({
      retry: { enabled: false },
    });

    sessionEventHandler?.({
      type: "message_start",
      message: { role: "user", content: "next request" },
    });
    expect(applyOverrides).toHaveBeenLastCalledWith({
      retry: { enabled: true },
    });

    sessionEventHandler?.({
      type: "tool_execution_start",
      toolCallId: "write-1",
      toolName: "write",
      args: { path: "result.txt" },
    });
    expect(applyOverrides).toHaveBeenLastCalledWith({
      retry: { enabled: false },
    });

    result.disposeDanoLlmResilience();
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(sessionResult.session.abort).not.toHaveBeenCalled();
  });

  it("enables auto compaction for initial and replacement runtime sessions", async () => {
    const services = {
      settingsManager: {
        getImageAutoResize: vi.fn().mockReturnValue(false),
        getRetryEnabled: vi.fn().mockReturnValue(true),
        applyOverrides: vi.fn(),
      },
    };
    const initialAutoCompaction = vi.fn();
    const replacementAutoCompaction = vi.fn();
    const createSession = (
      setAutoCompactionEnabled: ReturnType<typeof vi.fn>,
    ) => ({
      session: {
        setAutoCompactionEnabled,
        subscribe: vi.fn().mockReturnValue(() => {}),
      },
    });
    const sessionManager = { getCwd: vi.fn().mockReturnValue(tmpDir) };
    let runtimeFactory:
      | ((options: object) => Promise<{ session: object }>)
      | undefined;

    createAgentSessionServicesMock.mockResolvedValue(services);
    createReadToolDefinitionMock.mockReturnValue({ name: "read" });
    createCurlToolMock.mockReturnValue({ name: "curl" });
    createEditToolDefinitionMock.mockReturnValue({ name: "edit" });
    createWriteToolDefinitionMock.mockReturnValue({ name: "write" });
    createAgentSessionFromServicesMock
      .mockResolvedValueOnce(createSession(initialAutoCompaction))
      .mockResolvedValueOnce(createSession(replacementAutoCompaction));
    createAgentSessionRuntimeMock.mockImplementation(
      async (factory: typeof runtimeFactory, options: object) => {
        runtimeFactory = factory;
        const created = await factory?.(options);
        return {
          session: created?.session,
          setBeforeSessionInvalidate: vi.fn(),
        };
      },
    );

    await createDetachedAgentSessionRuntime(tmpDir, sessionManager as never);
    await runtimeFactory?.({
      cwd: tmpDir,
      agentDir: "/agent",
      sessionManager,
      sessionStartEvent: { type: "session_start", reason: "resume" },
    });

    expect(initialAutoCompaction).toHaveBeenCalledWith(true);
    expect(replacementAutoCompaction).toHaveBeenCalledWith(true);
  });
});
