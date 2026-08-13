import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  CredentialBroker,
  prepareProviderRequestArguments,
  type CredentialSession,
} from "../credential-broker.js";

interface FixtureCase {
  readonly name: string;
  readonly input: unknown;
  readonly expectedHeaders: Record<string, string>;
  readonly expectedBody?: unknown;
}

const fixtures = JSON.parse(
  fs.readFileSync(
    path.join(
      import.meta.dirname,
      "fixtures/provider-request-model-deviations.json",
    ),
    "utf8",
  ),
) as FixtureCase[];

describe("provider_request executable argument compatibility matrix", () => {
  it.each(fixtures)("normalizes $name", fixture => {
    const prepared = prepareProviderRequestArguments(fixture.input);

    expect(prepared.headers ?? {}).toEqual(fixture.expectedHeaders);
    if (Object.hasOwn(fixture, "expectedBody")) {
      expect(prepared).toHaveProperty("body", fixture.expectedBody);
    }
    expect(prepared).not.toHaveProperty("userId");
    expect(prepared).not.toHaveProperty("loginSessionId");
    expect(prepared).not.toHaveProperty("token");
    expect(prepared).not.toHaveProperty("origin");
  });

  it("returns a stable structured invalid result for malformed required fields", async () => {
    const observed = observableSession("agent-a");
    const broker = authenticatedBroker(observed.session);
    const prepared = prepareProviderRequestArguments({
      method: 1,
      path: ["/records"],
    });
    observed.emit(userMessageEvent());
    observed.emit({ type: "turn_start" } as AgentSessionEvent);
    const tool = broker.createTool("user-a");

    const result = await tool.execute(
      "invalid-provider-call",
      prepared,
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "agent-a" } } as never,
    );

    expect(result).not.toHaveProperty("isError");
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.any(String) }],
      details: {
        ok: false,
        status: "invalid",
        error: {
          code: "invalid_provider_request",
          category: "validation",
          message: "Provider request arguments are invalid.",
          retryable: true,
          issues: expect.arrayContaining([
            expect.objectContaining({
              code: "invalid_provider_method",
              path: "method",
            }),
            expect.objectContaining({
              code: "invalid_provider_path",
              path: "path",
            }),
          ]),
        },
      },
    });
    const textContent = result.content.find(content => content.type === "text");
    expect(JSON.parse(textContent?.text ?? "null")).toEqual(result.details);
  });

  it("returns a stable invalid result when body serialization fails", async () => {
    const observed = observableSession("agent-a");
    const broker = authenticatedBroker(observed.session);
    const circular: { self?: unknown } = {};
    circular.self = circular;
    observed.emit(userMessageEvent());
    observed.emit({ type: "turn_start" } as AgentSessionEvent);

    await expect(
      broker.request("user-a", "agent-a", {
        method: "POST",
        path: "/records",
        body: circular,
      }),
    ).resolves.toEqual({
      ok: false,
      status: "invalid",
      error: {
        code: "invalid_provider_request",
        category: "validation",
        message: "Provider request arguments are invalid.",
        retryable: true,
        issues: [
          {
            code: "invalid_provider_body",
            path: "body",
            message: "Body must be JSON serializable or a string.",
          },
        ],
      },
    });
  });

  it("projects custom tool results as JSON-safe browser and transcript data", async () => {
    const observed = observableSession("agent-a");
    const broker = authenticatedBroker(observed.session, async () =>
      new Response('{"items":[]}'),
    );
    observed.emit(userMessageEvent());
    observed.emit({ type: "turn_start" } as AgentSessionEvent);
    const tool = broker.createTool("user-a");

    const result = await tool.execute(
      "provider-call",
      { method: "GET", path: "/records", headers: null } as never,
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => "agent-a" } } as never,
    );
    const projection = JSON.parse(JSON.stringify(result)) as unknown;

    expect(projection).toEqual(result);
    expect(JSON.stringify(projection)).not.toMatch(
      /fixture-access|login_a|user-a|authorization|cookie/i,
    );
  });
});

function observableSession(sessionId: string) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  return {
    session: {
      sessionId,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies CredentialSession,
    emit(event: AgentSessionEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

function userMessageEvent(): AgentSessionEvent {
  return {
    type: "message_start",
    message: { role: "user", content: "request", timestamp: 1 },
  } as AgentSessionEvent;
}

function authenticatedBroker(
  session: CredentialSession,
  providerFetch: typeof fetch = vi.fn(async () => new Response("ok")),
): CredentialBroker {
  const broker = new CredentialBroker({
    providerApiOrigin: "https://provider.test",
    readCredential: async () => ({ accessToken: "fixture-access" }),
    fetch: providerFetch,
  });
  broker.observe("user-a", session);
  broker.queueAssistantTurn("user-a", session.sessionId, "login_a");
  return broker;
}
