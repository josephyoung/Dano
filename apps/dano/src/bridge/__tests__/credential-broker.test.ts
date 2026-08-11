import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  CredentialBroker,
  type CredentialSession,
} from "../credential-broker.js";

const TEST_SCOPE = "user-a";

function observableSession(sessionId: string) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session: CredentialSession = {
    sessionId,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    session,
    emit(event: AgentSessionEvent) {
      for (const listener of listeners) listener(event);
    },
  };
}

function userMessageEvent(
  text: string,
): Extract<AgentSessionEvent, { type: "message_start" }> {
  return {
    type: "message_start",
    message: { role: "user", content: text, timestamp: 1 },
  } as Extract<AgentSessionEvent, { type: "message_start" }>;
}

function turnStartEvent(): AgentSessionEvent {
  return { type: "turn_start" } as AgentSessionEvent;
}

function turnEndEvent(): AgentSessionEvent {
  return {
    type: "turn_end",
    message: {
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    },
    toolResults: [],
  } as AgentSessionEvent;
}

function broker(options: {
  credentials?: Record<string, string>;
  fetch?: typeof fetch;
}) {
  const credentials = options.credentials ?? {};
  return new CredentialBroker({
    providerApiOrigin: "https://provider.test",
    readCredential: async loginSessionId => {
      const accessToken = credentials[loginSessionId];
      return accessToken ? { accessToken } : null;
    },
    fetch: options.fetch,
  });
}

describe("Credential Broker", () => {
  it("rejects a provider API origin without TLS", () => {
    expect(
      () =>
        new CredentialBroker({
          providerApiOrigin: "http://provider.test",
          readCredential: async () => null,
        }),
    ).toThrow("Provider API origin must use HTTPS");
  });

  it("forwards a generic request to the configured provider origin", async () => {
    const providerFetch = vi.fn(async () =>
      new Response('{"ok":true}', {
        status: 201,
        headers: { "content-type": "application/json", "x-result": "saved" },
      }),
    );
    const credentialBroker = broker({
      credentials: { login_a: "access-a" },
      fetch: providerFetch as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("run skill"));
    observed.emit(turnStartEvent());

    await expect(
      credentialBroker.request(TEST_SCOPE, "agent-a", {
        method: "POST",
        path: "/business/items?limit=2",
        headers: {
          "content-type": "application/json",
          "x-request-id": "request-1",
        },
        body: { enabled: true },
      }),
    ).resolves.toEqual({
      ok: true,
      status: 201,
      headers: { "content-type": "application/json", "x-result": "saved" },
      body: '{"ok":true}',
    });
    expect(providerFetch).toHaveBeenCalledWith(
      new URL("https://provider.test/business/items?limit=2"),
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        headers: expect.objectContaining({
          authorization: "Bearer access-a",
          "content-type": "application/json",
          "x-request-id": "request-1",
        }),
        body: '{"enabled":true}',
      }),
    );
  });

  it("coalesces concurrent access-token failures into one Login Session refresh", async () => {
    let credential = {
      accessToken: "expired-access",
      refreshToken: "rotating-refresh",
    };
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>(resolve => {
      releaseRefresh = resolve;
    });
    const refreshCredential = vi.fn(async () => {
      await refreshGate;
      credential = {
        accessToken: "renewed-access",
        refreshToken: "rotated-refresh",
      };
      return credential;
    });
    const providerFetch = vi.fn(async (_url: URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer expired-access"
        ? new Response("expired", { status: 401 })
        : new Response("renewed", { status: 200 });
    });
    const credentialBroker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async () => credential,
      refreshCredential,
      fetch: providerFetch as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("run skill"));
    observed.emit(turnStartEvent());

    const first = credentialBroker.request(TEST_SCOPE, "agent-a", {
      method: "GET",
      path: "/first",
    });
    const second = credentialBroker.request(TEST_SCOPE, "agent-a", {
      method: "GET",
      path: "/second",
    });
    await vi.waitFor(() => expect(refreshCredential).toHaveBeenCalledOnce());
    releaseRefresh();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, status: 200, body: "renewed" }),
      expect.objectContaining({ ok: true, status: 200, body: "renewed" }),
    ]);
    expect(refreshCredential).toHaveBeenCalledWith("login_a");
    expect(providerFetch).toHaveBeenCalledTimes(4);
  });

  it("reuses a completed rotation for a late concurrent 401", async () => {
    let credential = {
      accessToken: "expired-access",
      refreshToken: "initial-refresh",
    };
    let releaseLateFailure!: () => void;
    const lateFailure = new Promise<void>(resolve => {
      releaseLateFailure = resolve;
    });
    let expiredRequests = 0;
    const refreshCredential = vi.fn(async () => {
      credential = {
        accessToken: "renewed-access",
        refreshToken: "rotated-refresh",
      };
      return credential;
    });
    const providerFetch = vi.fn(async (_url: URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer expired-access") {
        expiredRequests += 1;
        if (expiredRequests === 2) await lateFailure;
        return new Response("expired", { status: 401 });
      }
      return new Response("renewed", { status: 200 });
    });
    const credentialBroker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async () => credential,
      refreshCredential,
      fetch: providerFetch as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("run skill"));
    observed.emit(turnStartEvent());

    const first = credentialBroker.request(TEST_SCOPE, "agent-a", {
      method: "GET",
      path: "/first",
    });
    const second = credentialBroker.request(TEST_SCOPE, "agent-a", {
      method: "GET",
      path: "/second",
    });
    await expect(first).resolves.toMatchObject({ ok: true, status: 200 });
    releaseLateFailure();
    await expect(second).resolves.toMatchObject({ ok: true, status: 200 });

    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(providerFetch).toHaveBeenCalledTimes(4);
  });

  it("requires reauthentication only for the Login Session whose refresh fails", async () => {
    const credentials = {
      login_a: { accessToken: "expired-a", refreshToken: "refresh-a" },
      login_b: { accessToken: "access-b", refreshToken: "refresh-b" },
    };
    const requireReauthentication = vi.fn(async () => {});
    const providerFetch = vi.fn(async (_url: URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      return authorization === "Bearer access-b"
        ? new Response("session-b", { status: 200 })
        : new Response("private provider failure", { status: 401 });
    });
    const credentialBroker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async loginSessionId => credentials[loginSessionId as keyof typeof credentials],
      refreshCredential: async loginSessionId => {
        if (loginSessionId === "login_a") throw new Error("refresh-a-secret");
        return credentials.login_b;
      },
      requireReauthentication,
      fetch: providerFetch as typeof fetch,
    });
    const first = observableSession("agent-a");
    const second = observableSession("agent-b");
    credentialBroker.observe(TEST_SCOPE, first.session);
    credentialBroker.observe(TEST_SCOPE, second.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-b", "login_b");
    first.emit(userMessageEvent("first"));
    second.emit(userMessageEvent("second"));
    first.emit(turnStartEvent());
    second.emit(turnStartEvent());

    const [failed, unaffected] = await Promise.all([
      credentialBroker.request(TEST_SCOPE, "agent-a", {
        method: "GET",
        path: "/a",
      }),
      credentialBroker.request(TEST_SCOPE, "agent-b", {
        method: "GET",
        path: "/b",
      }),
    ]);

    expect(failed).toEqual({
      ok: false,
      error: {
        code: "reauth_required",
        message: "Login is required again for this provider request.",
      },
    });
    expect(JSON.stringify(failed)).not.toMatch(/private provider failure|refresh-a-secret|expired-a|refresh-a/);
    expect(unaffected).toMatchObject({ ok: true, status: 200, body: "session-b" });
    expect(requireReauthentication).toHaveBeenCalledOnce();
    expect(requireReauthentication).toHaveBeenCalledWith("login_a");
  });

  it("does not loop refresh when the retried request still rejects the access token", async () => {
    const refreshCredential = vi.fn(async () => ({
      accessToken: "still-invalid",
      refreshToken: "rotated-refresh",
    }));
    const requireReauthentication = vi.fn(async () => {});
    const providerFetch = vi.fn(async () =>
      new Response("invalid", { status: 401 }),
    );
    const credentialBroker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async () => ({
        accessToken: "expired-access",
        refreshToken: "initial-refresh",
      }),
      refreshCredential,
      requireReauthentication,
      fetch: providerFetch as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("run skill"));
    observed.emit(turnStartEvent());

    await expect(
      credentialBroker.request(TEST_SCOPE, "agent-a", {
        method: "GET",
        path: "/still-invalid",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "reauth_required" },
    });
    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(providerFetch).toHaveBeenCalledTimes(2);
    expect(requireReauthentication).toHaveBeenCalledOnce();
  });

  it("keeps the rotated Credential when the retried request has a transport failure", async () => {
    const refreshCredential = vi.fn(async () => ({
      accessToken: "renewed-access",
      refreshToken: "rotated-refresh",
    }));
    const requireReauthentication = vi.fn(async () => {});
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockRejectedValueOnce(new Error("temporary network failure"));
    const credentialBroker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async () => ({
        accessToken: "expired-access",
        refreshToken: "initial-refresh",
      }),
      refreshCredential,
      requireReauthentication,
      fetch: providerFetch as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("run skill"));
    observed.emit(turnStartEvent());

    await expect(
      credentialBroker.request(TEST_SCOPE, "agent-a", {
        method: "GET",
        path: "/temporary-failure",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "provider_request_failed",
        message: "The provider request failed.",
      },
    });
    expect(refreshCredential).toHaveBeenCalledOnce();
    expect(requireReauthentication).not.toHaveBeenCalled();
  });

  it("requires reauthentication without calling refresh when no refresh token exists", async () => {
    const refreshCredential = vi.fn();
    const requireReauthentication = vi.fn(async () => {});
    const credentialBroker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async () => ({ accessToken: "expired-access" }),
      refreshCredential,
      requireReauthentication,
      fetch: vi.fn(async () => new Response("invalid", { status: 401 })) as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("run skill"));
    observed.emit(turnStartEvent());

    await expect(
      credentialBroker.request(TEST_SCOPE, "agent-a", {
        method: "GET",
        path: "/invalid",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "reauth_required" },
    });
    expect(refreshCredential).not.toHaveBeenCalled();
    expect(requireReauthentication).toHaveBeenCalledOnce();
  });

  it("exposes the Broker through a Pi public custom tool without identity arguments", async () => {
    const credentialBroker = broker({
      credentials: { login_a: "access-a" },
      fetch: vi.fn(async () => new Response("skill-result")) as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("run skill"));
    observed.emit(turnStartEvent());

    const tool = credentialBroker.createTool(TEST_SCOPE);
    const result = await tool.execute(
      "provider-call",
      { method: "GET", path: "/skill" },
      undefined,
      undefined,
      {
        sessionManager: { getSessionId: () => "agent-a" },
      } as never,
    );

    expect(tool.name).toBe("provider_request");
    expect(JSON.stringify(tool.parameters)).not.toMatch(
      /userId|loginSessionId|token|origin/,
    );
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining('"body":"skill-result"'),
        },
      ],
      details: { ok: true, status: 200, body: "skill-result" },
    });
    expect(JSON.stringify(result)).not.toContain("access-a");
  });

  it("keeps one Assistant Turn on its initiating Login Session across tool cycles", async () => {
    const seenAuthorization: string[] = [];
    const providerFetch = vi.fn(async (_url: URL, init?: RequestInit) => {
      seenAuthorization.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("ok");
    });
    const credentialBroker = broker({
      credentials: { login_a: "access-a", login_b: "access-b" },
      fetch: providerFetch as typeof fetch,
    });
    const observed = observableSession("shared-agent");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "shared-agent", "login_a");
    observed.emit(userMessageEvent("first"));
    observed.emit(turnStartEvent());
    await credentialBroker.request(TEST_SCOPE, "shared-agent", { method: "GET", path: "/one" });
    observed.emit(turnEndEvent());
    observed.emit(turnStartEvent());
    await credentialBroker.request(TEST_SCOPE, "shared-agent", { method: "GET", path: "/two" });

    credentialBroker.queueAssistantTurn(TEST_SCOPE, "shared-agent", "login_b");
    observed.emit(userMessageEvent("follow up"));
    observed.emit(turnEndEvent());
    observed.emit(turnStartEvent());
    await credentialBroker.request(TEST_SCOPE, "shared-agent", { method: "GET", path: "/three" });

    expect(seenAuthorization).toEqual([
      "Bearer access-a",
      "Bearer access-a",
      "Bearer access-b",
    ]);
  });

  it("does not let another session or a reconnect change an active Turn", async () => {
    const seen = new Map<string, string>();
    const providerFetch = vi.fn(async (url: URL, init?: RequestInit) => {
      seen.set(url.pathname, new Headers(init?.headers).get("authorization") ?? "");
      return new Response("ok");
    });
    const credentialBroker = broker({
      credentials: { login_a: "access-a", login_b: "access-b" },
      fetch: providerFetch as typeof fetch,
    });
    const first = observableSession("agent-a");
    const second = observableSession("agent-b");
    credentialBroker.observe(TEST_SCOPE, first.session);
    credentialBroker.observe(TEST_SCOPE, second.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-b", "login_b");
    first.emit(userMessageEvent("one"));
    second.emit(userMessageEvent("two"));
    first.emit(turnStartEvent());
    second.emit(turnStartEvent());

    await Promise.all([
      credentialBroker.request(TEST_SCOPE, "agent-a", { method: "GET", path: "/a" }),
      credentialBroker.request(TEST_SCOPE, "agent-b", { method: "GET", path: "/b" }),
    ]);
    // Browser reconnects do not enqueue an Assistant Turn and therefore cannot rebind it.
    await credentialBroker.request(TEST_SCOPE, "agent-a", { method: "GET", path: "/a-again" });

    expect(Object.fromEntries(seen)).toEqual({
      "/a": "Bearer access-a",
      "/b": "Bearer access-b",
      "/a-again": "Bearer access-a",
    });
  });

  it("treats opaque scope and Session IDs as an unambiguous tuple", async () => {
    const seen = new Map<string, string>();
    const providerFetch = vi.fn(async (url: URL, init?: RequestInit) => {
      seen.set(
        url.pathname,
        new Headers(init?.headers).get("authorization") ?? "",
      );
      return new Response("ok");
    });
    const credentialBroker = broker({
      credentials: { login_a: "access-a", login_b: "access-b" },
      fetch: providerFetch as typeof fetch,
    });
    const first = observableSession("agent\0shared");
    const second = observableSession("shared");
    credentialBroker.observe("user", first.session);
    credentialBroker.observe("user\0agent", second.session);
    credentialBroker.queueAssistantTurn(
      "user",
      "agent\0shared",
      "login_a",
    );
    credentialBroker.queueAssistantTurn(
      "user\0agent",
      "shared",
      "login_b",
    );
    first.emit(userMessageEvent("one"));
    second.emit(userMessageEvent("two"));
    first.emit(turnStartEvent());
    second.emit(turnStartEvent());

    await Promise.all([
      credentialBroker.request("user", "agent\0shared", {
        method: "GET",
        path: "/user-a",
      }),
      credentialBroker.request("user\0agent", "shared", {
        method: "GET",
        path: "/user-b",
      }),
    ]);

    expect(Object.fromEntries(seen)).toEqual({
      "/user-a": "Bearer access-a",
      "/user-b": "Bearer access-b",
    });
  });

  it("isolates the same Agent Session ID across User Runtime scopes", async () => {
    const seenAuthorization: string[] = [];
    const credentialBroker = broker({
      credentials: { login_a: "access-a", login_b: "access-b" },
      fetch: vi.fn(async (_url: URL, init?: RequestInit) => {
        seenAuthorization.push(
          new Headers(init?.headers).get("authorization") ?? "",
        );
        return new Response("ok");
      }) as typeof fetch,
    });
    const first = observableSession("same-agent-session");
    const second = observableSession("same-agent-session");
    credentialBroker.observe("user-a", first.session);
    credentialBroker.observe("user-b", second.session);
    credentialBroker.queueAssistantTurn(
      "user-a",
      "same-agent-session",
      "login_a",
    );
    credentialBroker.queueAssistantTurn(
      "user-b",
      "same-agent-session",
      "login_b",
    );
    first.emit(userMessageEvent("one"));
    second.emit(userMessageEvent("two"));
    first.emit(turnStartEvent());
    second.emit(turnStartEvent());

    await credentialBroker.request("user-a", "same-agent-session", {
      method: "GET",
      path: "/a",
    });
    await credentialBroker.request("user-b", "same-agent-session", {
      method: "GET",
      path: "/b",
    });

    expect(seenAuthorization).toEqual([
      "Bearer access-a",
      "Bearer access-b",
    ]);
  });

  it("cancels the binding associated with a removed follow-up queue entry", async () => {
    const seenAuthorization: string[] = [];
    const credentialBroker = broker({
      credentials: { login_a: "access-a", login_b: "access-b" },
      fetch: vi.fn(async (_url: URL, init?: RequestInit) => {
        seenAuthorization.push(
          new Headers(init?.headers).get("authorization") ?? "",
        );
        return new Response("ok");
      }) as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    const firstHandle = credentialBroker.queueAssistantTurn(
      TEST_SCOPE,
      "agent-a",
      "login_a",
    );
    const secondHandle = credentialBroker.queueAssistantTurn(
      TEST_SCOPE,
      "agent-a",
      "login_b",
    );
    const firstEvent = userMessageEvent("removed follow-up");
    const secondEvent = userMessageEvent("kept follow-up");
    credentialBroker.associateQueuedAssistantTurn(
      firstHandle,
      firstEvent.message as object,
    );
    credentialBroker.associateQueuedAssistantTurn(
      secondHandle,
      secondEvent.message as object,
    );

    credentialBroker.cancelQueuedAssistantTurnForEntry(
      firstEvent.message as object,
    );
    observed.emit(secondEvent);
    observed.emit(turnStartEvent());
    await credentialBroker.request(TEST_SCOPE, "agent-a", {
      method: "GET",
      path: "/kept",
    });

    expect(seenAuthorization).toEqual(["Bearer access-b"]);
  });

  it("returns authentication_required for Anonymous Turns and revoked Login Sessions", async () => {
    const providerFetch = vi.fn();
    const credentials: Record<string, string> = { login_a: "access-a" };
    const credentialBroker = broker({
      credentials,
      fetch: providerFetch as typeof fetch,
    });
    const anonymous = observableSession("anonymous-agent");
    const authenticated = observableSession("authenticated-agent");
    credentialBroker.observe(TEST_SCOPE, anonymous.session);
    credentialBroker.observe(TEST_SCOPE, authenticated.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "anonymous-agent", undefined);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "authenticated-agent", "login_a");
    anonymous.emit(userMessageEvent("anonymous"));
    authenticated.emit(userMessageEvent("authenticated"));
    anonymous.emit(turnStartEvent());
    authenticated.emit(turnStartEvent());

    await expect(
      credentialBroker.request(TEST_SCOPE, "anonymous-agent", { method: "GET", path: "/me" }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "authentication_required",
        message: "Login is required for this provider request.",
      },
    });
    delete credentials.login_a;
    await expect(
      credentialBroker.request(TEST_SCOPE, "authenticated-agent", { method: "GET", path: "/me" }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "authentication_required",
        message: "Login is required for this provider request.",
      },
    });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("cannot send credentials to another origin through path, headers, or redirects", async () => {
    const providerFetch = vi.fn(async (_url: URL, init?: RequestInit) =>
      new Response("redirect", {
        status: 302,
        headers: {
          location: "https://outside.test/collect",
          "set-cookie": "provider_session=private",
        },
      }),
    );
    const credentialBroker = broker({
      credentials: { login_a: "access-a" },
      fetch: providerFetch as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("request"));
    observed.emit(turnStartEvent());

    await expect(
      credentialBroker.request(TEST_SCOPE, "agent-a", {
        method: "GET",
        path: "//outside.test/collect",
        headers: {
          authorization: "Bearer attacker-value",
          cookie: "attacker=1",
          host: "outside.test",
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_provider_request" },
    });
    expect(providerFetch).not.toHaveBeenCalled();

    const response = await credentialBroker.request(TEST_SCOPE, "agent-a", {
      method: "GET",
      path: "/redirect",
      headers: {
        authorization: "Bearer attacker-value",
        cookie: "attacker=1",
        host: "outside.test",
      },
    });
    expect(providerFetch).toHaveBeenCalledWith(
      new URL("https://provider.test/redirect"),
      expect.objectContaining({
        redirect: "manual",
        headers: { authorization: "Bearer access-a" },
      }),
    );
    expect(response).toEqual({
      ok: true,
      status: 302,
      headers: {
        "content-type": "text/plain;charset=UTF-8",
        location: "https://outside.test/collect",
      },
      body: "redirect",
    });
  });

  it("redacts provider credentials from responses and failures", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("echo access-a and refresh-a", {
          headers: { "x-echo": "access-a" },
        }),
      )
      .mockRejectedValueOnce(new Error("network failure access-a"));
    const credentialBroker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async () => ({
        accessToken: "access-a",
        refreshToken: "refresh-a",
      }),
      fetch: providerFetch as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("request"));
    observed.emit(turnStartEvent());

    const echoed = await credentialBroker.request(TEST_SCOPE, "agent-a", {
      method: "GET",
      path: "/echo",
    });
    const failed = await credentialBroker.request(TEST_SCOPE, "agent-a", {
      method: "GET",
      path: "/failure",
    });
    expect(JSON.stringify(echoed)).not.toContain("access-a");
    expect(JSON.stringify(echoed)).not.toContain("refresh-a");
    expect(JSON.stringify(failed)).not.toContain("access-a");
    expect(failed).toEqual({
      ok: false,
      error: {
        code: "provider_request_failed",
        message: "The provider request failed.",
      },
    });
  });

  it("redacts common transport encodings of a provider token", async () => {
    const accessToken = "access+token/value";
    const encoded = encodeURIComponent(accessToken);
    const credentialBroker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async () => ({ accessToken }),
      fetch: vi.fn(async () => new Response(`echo=${encoded}`)) as typeof fetch,
    });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("request"));
    observed.emit(turnStartEvent());

    const response = await credentialBroker.request(TEST_SCOPE, "agent-a", {
      method: "GET",
      path: "/echo",
    });

    expect(JSON.stringify(response)).not.toContain(encoded);
  });

  it("releases queued and active bindings when the observed session is disposed", async () => {
    const credentialBroker = broker({ credentials: { login_a: "access-a" } });
    const observed = observableSession("agent-a");
    const dispose = credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("request"));
    observed.emit(turnStartEvent());

    dispose();

    await expect(
      credentialBroker.request(TEST_SCOPE, "agent-a", { method: "GET", path: "/me" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authentication_required" },
    });
  });

  it("clears the active binding when Pi reports the Agent Session settled", async () => {
    const credentialBroker = broker({ credentials: { login_a: "access-a" } });
    const observed = observableSession("agent-a");
    credentialBroker.observe(TEST_SCOPE, observed.session);
    credentialBroker.queueAssistantTurn(TEST_SCOPE, "agent-a", "login_a");
    observed.emit(userMessageEvent("request"));
    observed.emit(turnStartEvent());
    observed.emit({ type: "agent_settled" } as AgentSessionEvent);

    await expect(
      credentialBroker.request(TEST_SCOPE, "agent-a", { method: "GET", path: "/me" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authentication_required" },
    });
  });
});
