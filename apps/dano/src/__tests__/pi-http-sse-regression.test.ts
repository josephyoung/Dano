import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createDanoBackendFromSession } from "../backend.js";
import {
  DEFAULT_BRIDGE_CONFIG,
  type ClientMessage,
  type ServerMessage,
} from "../bridge/types.js";
import { startDanoServer } from "../server.js";

function waitForSseMessage(
  url: string,
  predicate: (message: ServerMessage) => boolean,
  label = "expected SSE message",
): { close(): void; ready: Promise<void>; result: Promise<ServerMessage> } {
  let request: http.ClientRequest;
  let markReady: () => void;
  const ready = new Promise<void>(resolve => {
    markReady = resolve;
  });
  const result = new Promise<ServerMessage>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error(`Timed out waiting for ${label}`));
    }, 2_000);

    request = http.get(url, response => {
      markReady();
      response.setEncoding("utf8");
      response.on("data", chunk => {
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split(/\r?\n/)
            .filter(line => line.startsWith("data: "))
            .map(line => line.slice("data: ".length))
            .join("\n");
          if (data) {
            const message = JSON.parse(data) as ServerMessage;
            if (predicate(message)) {
              clearTimeout(timeout);
              resolve(message);
              return;
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  });

  return {
    ready,
    close() {
      request.destroy();
    },
    result,
  };
}

describe("Pi 0.82.1 HTTP/SSE regression baseline", () => {
  it("projects a real Pi runtime configured through package-root interfaces", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-pi-http-sse-"));
    const provider = fauxProvider({ provider: "dano-regression" });
    provider.setResponses([fauxAssistantMessage("baseline response")]);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(root, "agent", "auth.json"),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(provider.provider);
    await modelRuntime.getAvailable("dano-regression");

    const { session } = await createAgentSession({
      cwd: root,
      agentDir: path.join(root, "agent"),
      modelRuntime,
      model: provider.getModel(),
      thinkingLevel: "off",
      noTools: "all",
      sessionManager: SessionManager.inMemory(root),
    });
    const backend = createDanoBackendFromSession(session);
    const controller = await startDanoServer(
      {
        ...DEFAULT_BRIDGE_CONFIG,
        host: "127.0.0.1",
        port: 0,
        upload: {
          ...DEFAULT_BRIDGE_CONFIG.upload,
          uploadDir: path.join(root, "uploads"),
        },
      },
      { backend, captureSigint: false },
    );

    let sse: ReturnType<typeof waitForSseMessage> | undefined;
    try {
      const origin = controller.getBridgeUrl();
      if (!origin) throw new Error("Dano test server did not start");
      const createResponse = await fetch(`${origin}/api/clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        eventsUrl: string;
        messagesUrl: string;
      };
      sse = waitForSseMessage(
        `${origin}${created.eventsUrl}`,
        message =>
          message.type === "response" &&
          message.payload.id === "pi-baseline-models",
      );

      const command: ClientMessage = {
        type: "command",
        payload: { id: "pi-baseline-models", type: "get_available_models" },
      };
      const postResponse = await fetch(`${origin}${created.messagesUrl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      expect(postResponse.status).toBe(202);
      const response = await sse.result;

      expect(response).toMatchObject({
        type: "response",
        payload: {
          id: "pi-baseline-models",
          command: "get_available_models",
          success: true,
        },
      });
      const models = (
        response.payload as {
          data?: { models?: Array<{ provider: string; id: string }> };
        }
      ).data?.models;
      expect(models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            provider: "dano-regression",
            id: provider.getModel().id,
          }),
        ]),
      );
    } finally {
      sse?.close();
      await controller.stop();
      await backend.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects Pi settings for a lazy new session without creating its runtime", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-pi-settings-"));
    const provider = fauxProvider({
      provider: "dano-settings",
      models: [{ id: "configured", reasoning: true }],
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(root, "agent", "auth.json"),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(provider.provider);
    await modelRuntime.setRuntimeApiKey("dano-settings", "test-only");
    await modelRuntime.getAvailable("dano-settings");
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: "dano-settings",
      defaultModel: "configured",
      defaultThinkingLevel: "high",
    });
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: path.join(root, "agent"),
      modelRuntime,
      settingsManager,
      noTools: "all",
      sessionManager: SessionManager.create(root, root),
    });
    const backend = createDanoBackendFromSession(session);
    const controller = await startDanoServer(
      {
        ...DEFAULT_BRIDGE_CONFIG,
        host: "127.0.0.1",
        port: 0,
        upload: {
          ...DEFAULT_BRIDGE_CONFIG.upload,
          uploadDir: path.join(root, "uploads"),
        },
      },
      { backend, captureSigint: false },
    );

    let sse: ReturnType<typeof waitForSseMessage> | undefined;
    try {
      const origin = controller.getBridgeUrl();
      if (!origin) throw new Error("Dano test server did not start");
      const createResponse = await fetch(`${origin}/api/clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const created = (await createResponse.json()) as {
        eventsUrl: string;
        messagesUrl: string;
      };
      sse = waitForSseMessage(
        `${origin}${created.eventsUrl}`,
        message =>
          message.type === "response" &&
          message.payload.id === "lazy-new-session",
        "lazy new_session response",
      );
      await sse.ready;
      const response = await fetch(`${origin}${created.messagesUrl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "command",
          payload: { id: "lazy-new-session", type: "new_session" },
        } satisfies ClientMessage),
      });
      expect(response.status).toBe(202);
      const message = await sse.result;
      expect(message.payload).toMatchObject({
        command: "new_session",
        success: true,
        data: {
          model: { provider: "dano-settings", id: "configured" },
          thinkingLevel: "high",
        },
      });
      const sessionPath = (
        message.payload as { data?: { sessionPath?: string } }
      ).data?.sessionPath;
      expect(sessionPath).toEqual(expect.any(String));
      expect(fs.existsSync(sessionPath!)).toBe(false);
    } finally {
      sse?.close();
      await controller.stop();
      await backend.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("projects Pi-owned session defaults, selections, and pending count", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-pi-session-state-"));
    const provider = fauxProvider({
      provider: "dano-session-state",
      models: [
        { id: "fast", reasoning: true },
        { id: "default", reasoning: true },
      ],
      tokensPerSecond: 1,
    });
    provider.setResponses([
      fauxAssistantMessage(
        "This deliberately paced response keeps the real Pi session streaming.",
      ),
    ]);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(root, "agent", "auth.json"),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(provider.provider);
    await modelRuntime.setRuntimeApiKey("dano-session-state", "test-only");
    await modelRuntime.getAvailable("dano-session-state");
    const settingsManager = SettingsManager.inMemory({
      defaultProvider: "dano-session-state",
      defaultModel: "default",
      defaultThinkingLevel: "high",
    });
    const sessionManager = SessionManager.create(root, root);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: path.join(root, "agent"),
      modelRuntime,
      settingsManager,
      noTools: "all",
      sessionManager,
    });
    const backend = createDanoBackendFromSession(session);
    const controller = await startDanoServer(
      {
        ...DEFAULT_BRIDGE_CONFIG,
        host: "127.0.0.1",
        port: 0,
        upload: {
          ...DEFAULT_BRIDGE_CONFIG.upload,
          uploadDir: path.join(root, "uploads"),
        },
      },
      { backend, captureSigint: false },
    );

    const openSse: Array<ReturnType<typeof waitForSseMessage>> = [];
    try {
      const origin = controller.getBridgeUrl();
      if (!origin) throw new Error("Dano test server did not start");
      const createResponse = await fetch(`${origin}/api/clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const created = (await createResponse.json()) as {
        eventsUrl: string;
        messagesUrl: string;
      };
      const command = async (
        payload: Extract<ClientMessage, { type: "command" }>["payload"],
      ) => {
        const sse = waitForSseMessage(
          `${origin}${created.eventsUrl}`,
          message =>
            message.type === "response" && message.payload.id === payload.id,
          `response ${payload.id}`,
        );
        openSse.push(sse);
        await sse.ready;
        const response = await fetch(`${origin}${created.messagesUrl}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "command", payload } satisfies ClientMessage),
        });
        expect(response.status).toBe(202);
        return sse.result;
      };

      const initial = await command({ id: "initial-state", type: "get_state" });
      expect(initial.payload).toMatchObject({
        data: {
          model: { provider: "dano-session-state", id: "default" },
          thinkingLevel: "high",
          pendingMessageCount: 0,
        },
      });

      await command({
        id: "select-model",
        type: "set_model",
        provider: "dano-session-state",
        modelId: "fast",
      });
      await command({
        id: "select-thinking",
        type: "set_thinking_level",
        level: "low",
      });
      const selected = await command({ id: "selected-state", type: "get_state" });
      expect(selected.payload).toMatchObject({
        data: {
          model: { provider: "dano-session-state", id: "fast" },
          thinkingLevel: "low",
        },
      });

      await command({ id: "start-stream", type: "steer", message: "start" });
      let streaming = false;
      for (let attempt = 0; attempt < 20 && !streaming; attempt += 1) {
        const state = await command({
          id: `streaming-state-${attempt}`,
          type: "get_state",
        });
        streaming = Boolean(
          (state.payload as { data?: { isStreaming?: boolean } }).data
            ?.isStreaming,
        );
        if (!streaming) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(streaming).toBe(true);
      await command({ id: "queue-one", type: "follow_up", message: "one" });
      await command({ id: "queue-two", type: "follow_up", message: "two" });
      const queued = await command({ id: "queued-state", type: "get_state" });
      expect(queued.payload).toMatchObject({
        data: { pendingMessageCount: 2 },
      });
      await command({ id: "abort-stream", type: "abort" });
    } finally {
      for (const sse of openSse) sse.close();
      await controller.stop();
      await backend.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
