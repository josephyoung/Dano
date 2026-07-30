import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BRIDGE_CONFIG } from "../bridge/types.js";
import { createDanoBackendFromSession } from "../backend.js";
import { startDanoServer } from "../server.js";

function createMockSession() {
  let eventHandler: ((event: AgentSessionEvent) => void) | undefined;
  const unsubscribe = vi.fn();

  const sessionManager = {
    getCwd: vi.fn().mockReturnValue("/test/project"),
    getSessionDir: vi.fn().mockReturnValue("/test"),
    getSessionId: vi.fn().mockReturnValue("session-123"),
    getSessionFile: vi.fn().mockReturnValue("/test/session.jsonl"),
    getLeafId: vi.fn().mockReturnValue(null),
    getLeafEntry: vi.fn().mockReturnValue(undefined),
    getEntry: vi.fn().mockReturnValue(undefined),
    getLabel: vi.fn().mockReturnValue(undefined),
    getBranch: vi.fn().mockReturnValue([{ role: "user", content: "Hello" }]),
    getHeader: vi.fn().mockReturnValue(null),
    getEntries: vi.fn().mockReturnValue([{ role: "user", content: "Hello" }]),
    getTree: vi.fn().mockReturnValue([]),
    getSessionName: vi.fn().mockReturnValue("test-session"),
    appendModelChange: vi.fn(),
    appendThinkingLevelChange: vi.fn(),
  };

  const modelRuntime = {
    getAvailableSnapshot: vi.fn().mockReturnValue([
      {
        id: "gpt-4",
        name: "GPT-4",
        provider: "openai",
        api: "openai-responses",
        reasoning: true,
        contextWindow: 128000,
        maxTokens: 8192,
      },
    ]),
    getModel: vi.fn((provider: string, modelId: string) =>
      provider === "openai" && modelId === "gpt-4"
        ? {
            id: "gpt-4",
            name: "GPT-4",
            provider: "openai",
            api: "openai-responses",
            reasoning: true,
            contextWindow: 128000,
            maxTokens: 8192,
          }
        : undefined,
    ),
  };

  const extensionRunner = {
    getRegisteredCommands: vi
      .fn()
      .mockReturnValue([
        {
          name: "deploy",
          invocationName: "deploy:1",
          description: "First deploy command",
        },
        {
          name: "deploy",
          invocationName: "deploy:2",
          description: "Second deploy command",
        },
        {
          name: "template",
          invocationName: "template",
          description: "Extension wins callable-name collisions",
        },
      ]),
  };

  const session = {
    sessionManager,
    modelRuntime,
    settingsManager: {
      getDefaultProvider: vi.fn().mockReturnValue("openai"),
      getDefaultModel: vi.fn().mockReturnValue("gpt-4"),
      getDefaultThinkingLevel: vi.fn().mockReturnValue("medium"),
    },
    extensionRunner,
    promptTemplates: [
      { name: "template", description: "Shadowed prompt template" },
      { name: "review", description: "Review prompt template" },
    ],
    resourceLoader: {
      getSkills: vi.fn().mockReturnValue({
        skills: [
          { name: "audit", description: "Audit with the project skill" },
        ],
        diagnostics: [],
      }),
    },
    model: {
      id: "gpt-4",
      name: "GPT-4",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 8192,
    },
    thinkingLevel: "medium",
    pendingMessageCount: 0,
    isStreaming: false,
    getContextUsage: vi
      .fn()
      .mockReturnValue({ tokens: 1200, contextWindow: 8000, percent: 15 }),
    subscribe: vi.fn((handler: (event: AgentSessionEvent) => void) => {
      eventHandler = handler;
      return unsubscribe;
    }),
    sendUserMessage: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn(async model => {
      session.model = {
        ...session.model,
        ...model,
      };
    }),
    setThinkingLevel: vi.fn(level => {
      session.thinkingLevel = level;
    }),
    setSessionName: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    session: session as unknown as AgentSession,
    emit(event: AgentSessionEvent) {
      eventHandler?.(event);
    },
    unsubscribe,
  };
}

describe("Dano backend", () => {
  it("keeps ask_user_question retry state isolated per backend", async () => {
    const firstMock = createMockSession();
    const first = createDanoBackendFromSession(firstMock.session, {
      askUserQuestion: { maxRetries: 0 },
    });
    const secondMock = createMockSession();
    const second = createDanoBackendFromSession(secondMock.session, {
      askUserQuestion: { maxRetries: 2 },
    });
    const firstSignal = new AbortController().signal;
    const secondSignal = new AbortController().signal;

    expect(first.context.askUserQuestion.coordinator).not.toBe(
      second.context.askUserQuestion.coordinator,
    );
    await expect(
      first.context.askUserQuestion.coordinator.wait(
        "first-invalid",
        { questions: "{" },
        firstSignal,
      ),
    ).rejects.toThrow("QUESTION_VALIDATION_FAILED");
    await expect(
      second.context.askUserQuestion.coordinator.wait(
        "second-invalid-1",
        { questions: "{" },
        secondSignal,
      ),
    ).rejects.toThrow("questions must be valid JSON");
    await expect(
      second.context.askUserQuestion.coordinator.wait(
        "second-invalid-2",
        { questions: "{" },
        secondSignal,
      ),
    ).rejects.toThrow("questions must be valid JSON");
    await expect(
      second.context.askUserQuestion.coordinator.wait(
        "second-invalid-3",
        { questions: "{" },
        secondSignal,
      ),
    ).rejects.toThrow("QUESTION_VALIDATION_FAILED");

    await first.dispose();
    await second.dispose();
  });

  it("adapts an AgentSession into bridge state, actions, and events", async () => {
    const mock = createMockSession();
    const disposeDanoLlmResilience = vi.fn();
    const backend = createDanoBackendFromSession(
      mock.session,
      {},
      undefined,
      disposeDanoLlmResilience,
    );
    const received: string[] = [];

    backend.context.events.subscribe(event => {
      received.push(event.type);
    });

    expect(backend.context.state.cwd).toBe("/test/project");
    expect(backend.context.state.isIdle()).toBe(true);
    expect(backend.context.state.getPendingMessageCount()).toBe(0);
    expect(backend.context.state.getThinkingLevel()).toBe("medium");
    expect(backend.context.state.getCurrentModel()?.id).toBe("gpt-4");
    expect(backend.context.state.getConfiguredDefaultModel()?.id).toBe("gpt-4");
    expect(backend.context.state.getConfiguredDefaultThinkingLevel()).toBe(
      "medium",
    );
    expect(backend.context.state.getContextUsage()).toEqual({
      tokens: 1200,
      contextWindow: 8000,
      percent: 15,
    });
    expect(backend.context.actions.getCommands()).toEqual([
      {
        name: "deploy:1",
        description: "First deploy command",
        source: "extension",
      },
      {
        name: "deploy:2",
        description: "Second deploy command",
        source: "extension",
      },
      {
        name: "review",
        description: "Review prompt template",
        source: "prompt",
      },
      {
        name: "skill:audit",
        description: "Audit with the project skill",
        source: "skill",
      },
      {
        name: "template",
        description: "Extension wins callable-name collisions",
        source: "extension",
      },
    ]);

    mock.emit({ type: "agent_start" });
    mock.emit({
      type: "message_start",
      message: { role: "assistant", content: [] },
    } as unknown as AgentSessionEvent);
    mock.emit({
      type: "compaction_end",
      reason: "manual",
      result: undefined,
      aborted: false,
      willRetry: false,
    });

    expect(received).toEqual([
      "agent_start",
      "message_start",
      "session_compact",
    ]);
    expect(backend.context.state.getPendingMessageCount()).toBe(0);

    backend.context.actions.sendUserMessage("hello", { deliverAs: "followUp" });
    expect(mock.session.sendUserMessage).toHaveBeenCalledWith("hello", {
      deliverAs: "followUp",
    });

    backend.context.actions.abort();
    expect(mock.session.abort).toHaveBeenCalled();

    await backend.context.actions.setModel({
      id: "claude",
      provider: "anthropic",
    });
    expect(mock.session.setModel).toHaveBeenCalledWith({
      id: "claude",
      provider: "anthropic",
    });
    expect(received.at(-1)).toBe("model_select");

    backend.context.actions.setThinkingLevel("high");
    expect(mock.session.setThinkingLevel).toHaveBeenCalledWith("high");

    backend.context.actions.setSessionName("renamed");
    expect(mock.session.setSessionName).toHaveBeenCalledWith("renamed");

    await backend.dispose();
    expect(mock.unsubscribe).toHaveBeenCalled();
    expect(disposeDanoLlmResilience).toHaveBeenCalledTimes(1);
    expect(mock.session.dispose).toHaveBeenCalled();
    expect(disposeDanoLlmResilience.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(mock.session.dispose).mock.invocationCallOrder[0],
    );
  });

  it("starts and stops the Dano server lifecycle", async () => {
    const mock = createMockSession();
    const backend = createDanoBackendFromSession(mock.session);
    const controller = await startDanoServer(
      { ...DEFAULT_BRIDGE_CONFIG, port: 0 },
      {
        backend,
        captureSigint: false,
      },
    );

    expect(controller.getState().status).toBe("running");
    expect(controller.getBridgeUrl()).toMatch(/^http:\/\//);
    expect(controller.getClients()).toEqual([]);

    await controller.stop();

    expect(controller.getState()).toEqual({ status: "stopped" });
    expect(mock.session.dispose).not.toHaveBeenCalled();
  });

  it("reuses a provided backend across bridge restarts", async () => {
    const mock = createMockSession();
    const backend = createDanoBackendFromSession(mock.session);

    const first = await startDanoServer(
      { ...DEFAULT_BRIDGE_CONFIG, port: 0 },
      {
        backend,
        captureSigint: false,
      },
    );
    await first.stop();

    const second = await startDanoServer(
      { ...DEFAULT_BRIDGE_CONFIG, port: 0 },
      {
        backend,
        captureSigint: false,
      },
    );

    expect(second.getState().status).toBe("running");
    expect(mock.session.dispose).not.toHaveBeenCalled();

    await second.stop();
    await backend.dispose();

    expect(mock.session.dispose).toHaveBeenCalledTimes(1);
  });
});
