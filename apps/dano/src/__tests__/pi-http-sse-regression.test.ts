import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
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
): { close(): void; result: Promise<ServerMessage> } {
  let request: http.ClientRequest;
  const result = new Promise<ServerMessage>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error("Timed out waiting for the expected SSE message"));
    }, 2_000);

    request = http.get(url, response => {
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
});
