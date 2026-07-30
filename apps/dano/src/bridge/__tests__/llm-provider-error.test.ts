import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  DANO_LLM_RATE_LIMIT_ERROR,
  normalizeLlmErrorMessage,
} from "../llm-error.js";

const roots: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function startProvider(
  handler: http.RequestListener,
): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider test server did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}/v1`;
}

describe("Dano provider error projection", () => {
  it("persists the user JSONL before presenting a real provider 429 fixture", async () => {
    const baseUrl = await startProvider((_request, response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "429 rate limit exceeded",
            type: "rate_limit_error",
          },
        }),
      );
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-provider-error-"));
    roots.push(root);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(root, "agent", "auth.json"),
      modelsPath: null,
    });
    modelRuntime.registerProvider("provider-error-fixture", {
      api: "openai-completions",
      baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: "provider-error-fixture",
          name: "Provider Error Fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16_000,
          maxTokens: 1_024,
        },
      ],
    });
    const model = modelRuntime.getModel(
      "provider-error-fixture",
      "provider-error-fixture",
    );
    if (!model) throw new Error("Provider fixture model was not registered");
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: path.join(root, "agent"),
      modelRuntime,
      model,
      noTools: "all",
      sessionManager: SessionManager.create(root, root),
    });
    session.settingsManager.applyOverrides({ retry: { enabled: false } });

    try {
      await session.prompt("provider-rate-limit-prompt");
      const assistant = session.messages.at(-1);
      if (!assistant) throw new Error("provider did not produce a response");
      const sessionFile = session.sessionManager.getSessionFile();
      const jsonl = sessionFile ? fs.readFileSync(sessionFile, "utf8") : "";

      expect(jsonl).toContain('"role":"user"');
      expect(jsonl).toContain("provider-rate-limit-prompt");
      expect(assistant).toMatchObject({ role: "assistant", stopReason: "error" });
      expect(normalizeLlmErrorMessage(assistant)).toBe(
        DANO_LLM_RATE_LIMIT_ERROR,
      );
    } finally {
      session.dispose();
    }
  });
});
