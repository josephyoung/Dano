import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { startDanoServer } from "../server.js";
import {
  DEFAULT_BRIDGE_CONFIG,
  type ClientMessage,
  type ServerMessage,
} from "../bridge/types.js";

interface SseProbe {
  readonly ready: Promise<void>;
  close(): void;
  snapshot(): ServerMessage[];
  waitFor(
    predicate: (message: ServerMessage) => boolean,
    label: string,
  ): Promise<ServerMessage>;
}

const roots: string[] = [];
const providerServers: http.Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of providerServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function openSse(url: string): SseProbe {
  const messages: ServerMessage[] = [];
  const waiters = new Set<{
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
  }>();
  let markReady!: () => void;
  const ready = new Promise<void>(resolve => {
    markReady = resolve;
  });
  let buffer = "";

  const request = http.get(url, response => {
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
          messages.push(message);
          for (const waiter of [...waiters]) {
            if (!waiter.predicate(message)) continue;
            waiters.delete(waiter);
            waiter.resolve(message);
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    });
  });

  return {
    ready,
    close() {
      request.destroy();
    },
    snapshot() {
      return [...messages];
    },
    waitFor(predicate, label) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise<ServerMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${label}`));
        }, 3_000);
        const waiter = {
          predicate,
          resolve: (message: ServerMessage) => {
            clearTimeout(timer);
            resolve(message);
          },
        };
        waiters.add(waiter);
      });
    },
  };
}

async function startProvider(
  handler: http.RequestListener,
): Promise<string> {
  const server = http.createServer(handler);
  providerServers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Provider fixture did not bind to a TCP port");
  }
  return `http://127.0.0.1:${address.port}/v1`;
}

function writeCompletion(response: http.ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-provider-retry",
      object: "chat.completion.chunk",
      created: 1,
      model: "retry-fixture",
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-provider-retry",
      object: "chat.completion.chunk",
      created: 1,
      model: "retry-fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function writePartialThenDisconnect(
  response: http.ServerResponse,
  delta: { content?: string; reasoning_content?: string },
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-provider-partial",
      object: "chat.completion.chunk",
      created: 1,
      model: "retry-fixture",
      choices: [{ index: 0, delta, finish_reason: null }],
    })}\n\n`,
  );
  setTimeout(() => response.destroy(), 10);
}

function writeToolCall(
  response: http.ServerResponse,
  name: string,
  args: Record<string, unknown>,
): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-provider-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "retry-fixture",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "tool-call-once",
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      id: "chatcmpl-provider-tool",
      object: "chat.completion.chunk",
      created: 1,
      model: "retry-fixture",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

async function startRetryHarness(
  providerHandler: http.RequestListener,
  options: {
    retryDelayMs?: number;
    maxRetries?: number;
    assistantTurnTimeoutMs?: number;
    providerTimeoutMs?: number;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-provider-retry-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const baseUrl = await startProvider(providerHandler);

  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "retry-fixture": {
          baseUrl,
          api: "openai-completions",
          apiKey: "test-key",
          models: [
            {
              id: "retry-fixture",
              name: "Retry Fixture",
              reasoning: true,
              input: ["text"],
              contextWindow: 16_000,
              maxTokens: 1_024,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
            },
          ],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "retry-fixture",
      defaultModel: "retry-fixture",
      defaultThinkingLevel: "off",
      retry: {
        enabled: true,
        maxRetries: options.maxRetries ?? 1,
        baseDelayMs: options.retryDelayMs ?? 0,
        provider: {
          maxRetries: 0,
          ...(options.providerTimeoutMs === undefined
            ? {}
            : { timeoutMs: options.providerTimeoutMs }),
        },
      },
    }),
  );
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  if (options.assistantTurnTimeoutMs !== undefined) {
    vi.stubEnv(
      "DANO_ASSISTANT_TURN_TIMEOUT_MS",
      String(options.assistantTurnTimeoutMs),
    );
  }

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
    { cwd: workspace, sessionDir, captureSigint: false },
  );
  const origin = controller.getBridgeUrl();
  if (!origin) throw new Error("Dano retry fixture did not start");
  const createResponse = await fetch(`${origin}/api/clients`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const created = (await createResponse.json()) as {
    client: { id: string };
    eventsUrl: string;
    messagesUrl: string;
  };
  const sse = openSse(`${origin}${created.eventsUrl}`);
  await sse.ready;

  return {
    sse,
    async send(command: ClientMessage) {
      const response = await fetch(`${origin}${created.messagesUrl}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      expect(response.status).toBe(202);
    },
    async startPrompt(message: string) {
      await this.send({
        type: "command",
        payload: { id: "provider-retry-prompt", type: "prompt", message },
      });
    },
    async prompt(message: string) {
      await this.startPrompt(message);
      await sse.waitFor(
        candidate =>
          candidate.type === "event" &&
          candidate.payload.type === "agent_end",
        "terminal agent_end",
      );
    },
    async disconnect() {
      const response = await fetch(
        `${origin}/api/clients/${encodeURIComponent(created.client.id)}/disconnect`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(202);
    },
    async dispose() {
      sse.close();
      await controller.stop();
    },
  };
}

function eventPayloads(messages: readonly ServerMessage[]) {
  return messages.flatMap(message =>
    message.type === "event" ? [message.payload] : [],
  );
}

describe("Pi-owned provider retry over HTTP/SSE", () => {
  it("projects one Pi retry and one final answer after a transient provider failure", async () => {
    let providerRequests = 0;
    const harness = await startRetryHarness((_request, response) => {
      providerRequests += 1;
      if (providerRequests === 1) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }),
        );
        return;
      }
      writeCompletion(response, "Pi retry succeeded.");
    });

    try {
      await harness.prompt("retry once");
      const payloads = eventPayloads(harness.sse.snapshot());

      expect(providerRequests).toBe(2);
      expect(payloads.filter(payload => payload.type === "auto_retry_start"))
        .toEqual([
          expect.objectContaining({
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 1,
            delayMs: 0,
          }),
        ]);
      expect(payloads.filter(payload => payload.type === "agent_end"))
        .toHaveLength(1);
      expect(
        payloads.filter(
          payload =>
            payload.type === "transcript_upsert" &&
            payload.message.role === "assistant" &&
            payload.message.stopReason === "error",
        ),
      ).toHaveLength(0);
      const finalAnswerKeys = payloads.flatMap(payload =>
        payload.type === "transcript_upsert" &&
        payload.message.role === "assistant" &&
        JSON.stringify(payload.message.content).includes("Pi retry succeeded.")
          ? [payload.message.transcriptKey ?? payload.message.id]
          : [],
      );
      expect(finalAnswerKeys).not.toContain(undefined);
      expect(new Set(finalAnswerKeys).size).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("aborts the active provider at the remaining Assistant Turn budget", async () => {
    let providerRequests = 0;
    let providerCancellations = 0;
    const harness = await startRetryHarness((request, _response) => {
      providerRequests += 1;
      request.once("close", () => {
        providerCancellations += 1;
      });
    }, { assistantTurnTimeoutMs: 500 });

    try {
      await harness.prompt("respect the total turn budget");
      expect(providerRequests).toBe(1);
      await vi.waitFor(() => expect(providerCancellations).toBe(1));
      const payloads = eventPayloads(harness.sse.snapshot());

      expect(payloads.filter(payload => payload.type === "auto_retry_start"))
        .toHaveLength(0);
      expect(payloads.filter(payload => payload.type === "agent_end"))
        .toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  it.each([
    {
      label: "text",
      delta: { content: "visible partial text" },
      expected: "visible partial text",
    },
    {
      label: "thinking",
      delta: { reasoning_content: "visible thinking" },
      expected: "visible thinking",
    },
  ])("does not retry after visible $label output", async ({ delta, expected }) => {
    let providerRequests = 0;
    const harness = await startRetryHarness((_request, response) => {
      providerRequests += 1;
      writePartialThenDisconnect(response, delta);
    });

    try {
      await harness.prompt("stream then fail");
      const payloads = eventPayloads(harness.sse.snapshot());

      expect(providerRequests).toBe(1);
      expect(payloads.filter(payload => payload.type === "auto_retry_start"))
        .toHaveLength(0);
      expect(payloads.filter(payload => payload.type === "agent_end"))
        .toHaveLength(1);
      expect(JSON.stringify(payloads)).toContain(expected);
    } finally {
      await harness.dispose();
    }
  });

  it("does not retry after a mutating tool starts and executes the tool once", async () => {
    let providerRequests = 0;
    const harness = await startRetryHarness((_request, response) => {
      providerRequests += 1;
      if (providerRequests === 1) {
        writeToolCall(response, "write", {
          path: "result.txt",
          content: "written once",
        });
        return;
      }
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ error: { message: "rate limited after tool" } }),
      );
    });

    try {
      await harness.prompt("write a result");
      const payloads = eventPayloads(harness.sse.snapshot());

      expect(providerRequests).toBe(2);
      expect(payloads.filter(payload => payload.type === "auto_retry_start"))
        .toHaveLength(0);
      expect(payloads.filter(payload => payload.type === "agent_end"))
        .toHaveLength(1);
      expect(
        fs.readFileSync(path.join(roots.at(-1)!, "workspace", "result.txt"), "utf8"),
      ).toBe("written once");
      expect(
        payloads.filter(
          payload =>
            payload.type === "transcript_upsert" &&
            payload.message.role === "toolResult",
        ),
      ).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  it("cancels a scheduled Pi retry idempotently through abort_retry", async () => {
    let providerRequests = 0;
    const harness = await startRetryHarness((_request, response) => {
      providerRequests += 1;
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "retry later" } }));
    }, { retryDelayMs: 1_000 });

    try {
      await harness.startPrompt("cancel the scheduled retry");
      await harness.sse.waitFor(
        message =>
          message.type === "event" &&
          message.payload.type === "auto_retry_start",
        "auto_retry_start",
      );
      await harness.send({
        type: "command",
        payload: { id: "abort-retry-1", type: "abort_retry" },
      });
      await harness.send({
        type: "command",
        payload: { id: "abort-retry-2", type: "abort_retry" },
      });
      await harness.sse.waitFor(
        message =>
          message.type === "event" && message.payload.type === "agent_end",
        "terminal agent_end after abort_retry",
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      const payloads = eventPayloads(harness.sse.snapshot());

      expect(providerRequests).toBe(1);
      expect(payloads.filter(payload => payload.type === "auto_retry_start"))
        .toHaveLength(1);
      expect(payloads.filter(payload => payload.type === "agent_end"))
        .toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  it("aborts an active provider idempotently without a late terminal event", async () => {
    let providerRequests = 0;
    let providerCancellations = 0;
    const harness = await startRetryHarness(request => {
      providerRequests += 1;
      request.once("close", () => {
        providerCancellations += 1;
      });
    });

    try {
      await harness.startPrompt("abort the active provider");
      await vi.waitFor(() => expect(providerRequests).toBe(1));
      await harness.send({
        type: "command",
        payload: { id: "abort-provider-1", type: "abort" },
      });
      await harness.send({
        type: "command",
        payload: { id: "abort-provider-2", type: "abort" },
      });
      await harness.sse.waitFor(
        message =>
          message.type === "event" && message.payload.type === "agent_end",
        "terminal agent_end after abort",
      );
      await new Promise(resolve => setTimeout(resolve, 50));
      const payloads = eventPayloads(harness.sse.snapshot());

      expect(providerRequests).toBe(1);
      expect(providerCancellations).toBe(1);
      expect(payloads.filter(payload => payload.type === "agent_end"))
        .toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  it("cancels a scheduled Pi retry when the final viewer is destroyed", async () => {
    let providerRequests = 0;
    const harness = await startRetryHarness((_request, response) => {
      providerRequests += 1;
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "retry later" } }));
    }, { retryDelayMs: 100 });

    try {
      await harness.startPrompt("disconnect during retry delay");
      await harness.sse.waitFor(
        message =>
          message.type === "event" &&
          message.payload.type === "auto_retry_start",
        "auto_retry_start before final viewer disconnect",
      );
      await harness.disconnect();
      await new Promise(resolve => setTimeout(resolve, 250));

      expect(providerRequests).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("cancels the provider once when the final viewer is destroyed", async () => {
    let providerRequests = 0;
    let providerCancellations = 0;
    const harness = await startRetryHarness((request, _response) => {
      providerRequests += 1;
      request.once("close", () => {
        providerCancellations += 1;
      });
    });

    try {
      await harness.startPrompt("disconnect the final viewer");
      await vi.waitFor(() => expect(providerRequests).toBe(1));
      await harness.disconnect();
      await vi.waitFor(() => expect(providerCancellations).toBe(1));
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(providerRequests).toBe(1);
      expect(providerCancellations).toBe(1);
    } finally {
      await harness.dispose();
    }
  });

  it("projects one final error after Pi exhausts its retries", async () => {
    let providerRequests = 0;
    const harness = await startRetryHarness((_request, response) => {
      providerRequests += 1;
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "still rate limited" } }));
    });

    try {
      await harness.prompt("exhaust the retry");
      await new Promise(resolve => setTimeout(resolve, 50));
      const payloads = eventPayloads(harness.sse.snapshot());

      expect(providerRequests).toBe(2);
      expect(payloads.filter(payload => payload.type === "auto_retry_start"))
        .toHaveLength(1);
      expect(payloads.filter(payload => payload.type === "agent_end"))
        .toHaveLength(1);
      expect(
        payloads.filter(
          payload =>
            payload.type === "transcript_upsert" &&
            payload.message.role === "assistant" &&
            payload.message.stopReason === "error",
        ),
      ).toHaveLength(1);
    } finally {
      await harness.dispose();
    }
  });

  it("uses Pi's per-request timeout inside the larger Assistant Turn budget", async () => {
    let providerRequests = 0;
    const harness = await startRetryHarness(() => {
      providerRequests += 1;
    }, {
      maxRetries: 0,
      providerTimeoutMs: 100,
      assistantTurnTimeoutMs: 2_000,
    });

    try {
      await harness.prompt("let Pi time out the provider request");
      const payloads = eventPayloads(harness.sse.snapshot());

      expect(providerRequests).toBe(1);
      expect(payloads.filter(payload => payload.type === "auto_retry_start"))
        .toHaveLength(0);
      expect(payloads.filter(payload => payload.type === "agent_end"))
        .toHaveLength(1);
      expect(JSON.stringify(payloads)).toContain("DANO_LLM_TIMEOUT");
    } finally {
      await harness.dispose();
    }
  });
});
