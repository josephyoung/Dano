/** @vitest-environment happy-dom */

import type {
  BridgeAuthenticationState,
  BridgeUserSummary,
} from "@dano/types/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;

  readyState = FakeEventSource.CONNECTING;

  constructor(readonly url: string) {
    super();
    eventSources.push(this);
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(payload: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

const eventSources: FakeEventSource[] = [];

async function connectBridge(
  promptResponse: Promise<Response> | (() => Promise<Response>),
  onPromptRequest?: (init: RequestInit | undefined) => void,
  currentUser?: BridgeUserSummary,
  authentication?: BridgeAuthenticationState,
) {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input) === "/api/clients") {
      return new Response(
        JSON.stringify({
          client: { id: "client-1" },
          eventsUrl: "/events",
          messagesUrl: "/messages",
          ...(currentUser ? { currentUser } : {}),
          ...(authentication ? { authentication } : {}),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    const envelope = JSON.parse(String(init?.body ?? "{}")) as {
      payload?: { type?: string };
    };
    if (envelope.payload?.type === "prompt") {
      onPromptRequest?.(init);
      return typeof promptResponse === "function"
        ? promptResponse()
        : promptResponse;
    }
    return new Response(null, { status: 202 });
  });
  vi.stubGlobal("fetch", fetchImpl);
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);

  const { initBridge } = await import("./bridgeStore.svelte");
  const bridge = initBridge();
  await vi.waitFor(() => expect(eventSources).toHaveLength(1));
  eventSources[0]!.open();
  await vi.waitFor(() => expect(bridge.connectionStatus).toBe("connected"));
  return bridge;
}

describe("Bridge prompt acceptance", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
    eventSources.length = 0;
  });

  it("projects checking before the server resolves authentication", async () => {
    const current = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async input => {
        if (String(input) === "/api/auth/current") return current.promise;
        return new Response(null, { status: 503 });
      }),
    );
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);

    const { initBridge } = await import("./bridgeStore.svelte");
    const bridge = initBridge();

    expect(bridge.authentication).toEqual({ status: "checking" });
    current.resolve(
      new Response(JSON.stringify({ status: "anonymous" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    bridge.disconnect();
  });

  it("does not accept the Web-only checking state from auth current", async () => {
    const clientResponse = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (String(input) === "/api/auth/current") {
        return new Response(
          JSON.stringify({
            status: "checking",
            loginError: { code: "provider_login_failed" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(input) === "/api/clients") return clientResponse.promise;
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);

    const { initBridge, parseBridgeAuthenticationState } = await import(
      "./bridgeStore.svelte"
    );
    expect(
      parseBridgeAuthenticationState({ status: "checking" }),
    ).toBeUndefined();
    const bridge = initBridge();
    await vi.waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledWith(
        "/api/clients",
        expect.objectContaining({ method: "POST" }),
      ),
    );

    expect(bridge.authentication).toEqual({ status: "checking" });
    expect(bridge.notifications).toEqual([]);
    clientResponse.resolve(new Response(null, { status: 503 }));
    bridge.disconnect();
  });

  it("does not accept the Web-only checking state from client creation", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (String(input) === "/api/auth/current") {
        return new Response(JSON.stringify({ status: "anonymous" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(input) === "/api/clients") {
        return new Response(
          JSON.stringify({
            client: { id: "client-1" },
            eventsUrl: "/events",
            messagesUrl: "/messages",
            authentication: { status: "checking" },
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);

    const { initBridge } = await import("./bridgeStore.svelte");
    const bridge = initBridge();
    await vi.waitFor(() => expect(eventSources).toHaveLength(1));
    eventSources[0]!.open();
    await vi.waitFor(() => expect(bridge.connectionStatus).toBe("connected"));

    expect(bridge.authentication).toEqual({ status: "anonymous" });
    bridge.disconnect();
  });

  it("exposes the server-projected User summary to the application", async () => {
    const bridge = await connectBridge(
      Promise.resolve(new Response(null, { status: 202 })),
      undefined,
      {
        id: "user-alice",
        username: "Alice",
        avatarUrl: "https://example.test/alice.png",
      },
    );

    expect(bridge.currentUser).toEqual({
      id: "user-alice",
      username: "Alice",
      avatarUrl: "https://example.test/alice.png",
    });
    bridge.disconnect();
  });

  it("exposes Anonymous as a normal server-projected authentication state", async () => {
    const bridge = await connectBridge(
      Promise.resolve(new Response(null, { status: 202 })),
      undefined,
      undefined,
      { status: "anonymous" },
    );

    expect(bridge.authentication).toEqual({ status: "anonymous" });
    expect(bridge.currentUser).toBeUndefined();
    bridge.disconnect();
  });

  it("shows a recoverable login failure from one-time auth current state", async () => {
    let currentReads = 0;
    const clientResponse = deferred<Response>();
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (String(input) === "/api/auth/current") {
        currentReads += 1;
        return new Response(
          JSON.stringify({
            status: "anonymous",
            loginError: { code: "provider_identity_invalid" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(input) === "/api/clients") {
        return clientResponse.promise;
      }
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);
    window.history.replaceState({}, "", "/chat");
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined);

    const { initBridge } = await import("./bridgeStore.svelte");
    const bridge = initBridge();
    await vi.waitFor(() =>
      expect(bridge.authentication).toEqual({
        status: "anonymous",
        loginError: { code: "provider_identity_invalid" },
      }),
    );
    expect(bridge.notifications.at(-1)).toMatchObject({
      message: "登录失败，请重试",
      notifyType: "error",
    });
    clientResponse.resolve(
      new Response(
        JSON.stringify({
          client: { id: "client-1" },
          eventsUrl: "/events",
          messagesUrl: "/messages",
          authentication: { status: "anonymous" },
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    await vi.waitFor(() => expect(eventSources).toHaveLength(1));
    eventSources[0]!.open();
    await vi.waitFor(() => expect(bridge.connectionStatus).toBe("connected"));

    expect(currentReads).toBe(1);
    expect(bridge.authentication).toEqual({ status: "anonymous" });
    expect(bridge.notifications.at(-1)).toMatchObject({
      message: "登录失败，请重试",
      notifyType: "error",
    });
    bridge.login();
    expect(assign).toHaveBeenCalledWith(
      "/api/auth/login?returnTo=%2Fchat",
    );
    bridge.disconnect();
  });

  it("restores reauthentication from auth current without creating a Bridge Client", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      if (String(input) === "/api/auth/current") {
        return new Response(JSON.stringify({ status: "reauth_required" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 500 });
    });
    vi.stubGlobal("fetch", fetchImpl);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);

    const { initBridge } = await import("./bridgeStore.svelte");
    const bridge = initBridge();

    await vi.waitFor(() =>
      expect(bridge.authentication).toEqual({ status: "reauth_required" }),
    );
    expect(fetchImpl).not.toHaveBeenCalledWith(
      "/api/clients",
      expect.anything(),
    );
    expect(eventSources).toHaveLength(0);
    bridge.disconnect();
  });

  it("applies a server-projected reauthentication state from SSE without reconnecting", async () => {
    const bridge = await connectBridge(
      Promise.resolve(new Response(null, { status: 202 })),
      undefined,
      { id: "user-alice", username: "Alice" },
      {
        status: "authenticated",
        user: { id: "user-alice", username: "Alice" },
      },
    );

    eventSources[0]!.send({
      type: "authentication",
      payload: { status: "reauth_required" },
    });
    await vi.waitFor(() =>
      expect(bridge.authentication).toEqual({ status: "reauth_required" }),
    );
    eventSources[0]!.close();
    eventSources[0]!.dispatchEvent(new Event("error"));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(bridge.currentUser).toBeUndefined();
    expect(eventSources).toHaveLength(1);
    bridge.disconnect();
  });

  it("ignores the Web-only checking state when it arrives over SSE", async () => {
    const bridge = await connectBridge(
      Promise.resolve(new Response(null, { status: 202 })),
      undefined,
      undefined,
      { status: "anonymous" },
    );

    eventSources[0]!.send({
      type: "authentication",
      payload: { status: "checking" },
    });
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(bridge.authentication).toEqual({ status: "anonymous" });
    bridge.disconnect();
  });

  it("starts login with the current same-origin Dano return path", async () => {
    const bridge = await connectBridge(
      Promise.resolve(new Response(null, { status: 202 })),
      undefined,
      undefined,
      { status: "anonymous" },
    );
    window.history.replaceState({}, "", "/chat?session=one#latest");
    const assign = vi
      .spyOn(window.location, "assign")
      .mockImplementation(() => undefined);

    bridge.login();

    expect(assign).toHaveBeenCalledWith(
      "/api/auth/login?returnTo=%2Fchat%3Fsession%3Done%23latest",
    );
    bridge.disconnect();
  });

  it("posts same-origin logout and reloads into a fresh Anonymous User", async () => {
    const bridge = await connectBridge(
      Promise.resolve(new Response(null, { status: 202 })),
      undefined,
      { id: "user-alice", username: "Alice" },
      {
        status: "authenticated",
        user: { id: "user-alice", username: "Alice" },
      },
    );
    const logoutFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ status: "anonymous" })));
    vi.stubGlobal("fetch", logoutFetch);
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => undefined);

    await bridge.logout();

    expect(logoutFetch).toHaveBeenCalledWith("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
    });
    expect(reload).toHaveBeenCalledOnce();
    bridge.disconnect();
  });

  it("serializes first-client bootstrap across tabs before creating a guest", async () => {
    const request = vi.fn(
      async (_name: string, callback: () => Promise<Response>) => callback(),
    );
    vi.stubGlobal("navigator", {
      locks: { request },
      sendBeacon: () => true,
    });

    const bridge = await connectBridge(
      Promise.resolve(new Response(null, { status: 202 })),
      undefined,
      undefined,
      { status: "anonymous" },
    );

    expect(request).toHaveBeenCalledWith(
      "dano-anonymous-user-bootstrap",
      expect.any(Function),
    );
    bridge.disconnect();
  });

  it("waits for HTTP 202 without restoring pending after an earlier server event", async () => {
    const promptResponse = deferred<Response>();
    const bridge = await connectBridge(promptResponse.promise);

    const submitted = bridge.sendPrompt("ordinary short prompt");
    await vi.waitFor(() => expect(bridge.isPromptPending).toBe(true));

    eventSources[0]!.send({
      type: "event",
      payload: { type: "agent_end", sessionPath: null },
    });
    expect(bridge.isPromptPending).toBe(false);

    promptResponse.resolve(new Response(null, { status: 202 }));
    await expect(submitted).resolves.toBe(true);
    expect(bridge.isPromptPending).toBe(false);

    bridge.disconnect();
  });

  it("keeps the prompt unaccepted and exposes an actionable HTTP error", async () => {
    const bridge = await connectBridge(
      Promise.resolve(
        new Response(JSON.stringify({ error: "RECONNECT_REQUIRED" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(bridge.sendPrompt("retry me")).resolves.toBe(false);
    expect(bridge.isPromptPending).toBe(false);
    expect(bridge.connectionStatus).toBe("disconnected");
    expect(bridge.notifications.at(-1)).toMatchObject({
      notifyType: "error",
      message: expect.stringMatching(/刷新|refresh/i),
    });

    bridge.disconnect();
  });

  it("waits for streaming follow-up acknowledgement and rolls back only its optimistic message", async () => {
    const promptResponse = deferred<Response>();
    const bridge = await connectBridge(promptResponse.promise);
    eventSources[0]!.send({
      type: "event",
      payload: { type: "agent_start", sessionPath: null },
    });
    expect(bridge.isStreaming).toBe(true);

    const submitted = bridge.sendPrompt(
      "queued by this submission",
      undefined,
      undefined,
      "followUp",
    );
    await vi.waitFor(() =>
      expect(bridge.queuedUserMessages).toMatchObject([
        { text: "queued by this submission", queueType: "followUp" },
      ]),
    );

    eventSources[0]!.send({
      type: "event",
      payload: {
        type: "queue_update",
        sessionPath: null,
        steering: [],
        followUp: [
          {
            text: "authoritative queued message",
            images: [],
            timestamp: 123,
            queueType: "followUp",
          },
        ],
      },
    });
    expect(bridge.queuedUserMessages).toMatchObject([
      { text: "authoritative queued message", queueType: "followUp" },
    ]);

    promptResponse.resolve(
      new Response(JSON.stringify({ error: "RECONNECT_REQUIRED" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(submitted).resolves.toBe(false);
    expect(bridge.queuedUserMessages).toMatchObject([
      { text: "authoritative queued message", queueType: "followUp" },
    ]);

    bridge.disconnect();
  });

  it("rolls back rejected steering and sends one request on explicit retry", async () => {
    const promptResponse = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "bridge unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const bridge = await connectBridge(promptResponse);
    eventSources[0]!.send({
      type: "event",
      payload: { type: "agent_start", sessionPath: null },
    });

    await expect(
      bridge.sendPrompt("steer this turn", undefined, undefined, "steer"),
    ).resolves.toBe(false);
    expect(bridge.queuedUserMessages).toEqual([]);
    expect(promptResponse).toHaveBeenCalledTimes(1);

    await expect(
      bridge.sendPrompt("steer this turn", undefined, undefined, "steer"),
    ).resolves.toBe(true);
    expect(bridge.queuedUserMessages).toMatchObject([
      { text: "steer this turn", queueType: "steering" },
    ]);
    expect(promptResponse).toHaveBeenCalledTimes(2);

    bridge.disconnect();
  });

  it.each([
    ["follow-up", "followUp" as const, "followUp" as const],
    ["steering", "steer" as const, "steering" as const],
  ])(
    "aborts a timed-out streaming %s, returns false for Composer, and preserves the authoritative queue",
    async (_label, streamingBehavior, queueType) => {
      let requestSignal: AbortSignal | undefined;
      const bridge = await connectBridge(
        new Promise<Response>(() => {}),
        init => {
          requestSignal = init?.signal ?? undefined;
        },
      );
      eventSources[0]!.send({
        type: "event",
        payload: { type: "agent_start", sessionPath: null },
      });
      vi.useFakeTimers();

      const submitted = bridge.sendPrompt(
        "times out in the browser queue",
        undefined,
        undefined,
        streamingBehavior,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(bridge.queuedUserMessages).toMatchObject([
        { text: "times out in the browser queue", queueType },
      ]);

      eventSources[0]!.send({
        type: "event",
        payload: {
          type: "queue_update",
          sessionPath: null,
          steering:
            queueType === "steering"
              ? [
                  {
                    text: "authoritative queued message",
                    images: [],
                    timestamp: 123,
                    queueType: "steering",
                  },
                ]
              : [],
          followUp:
            queueType === "followUp"
              ? [
                  {
                    text: "authoritative queued message",
                    images: [],
                    timestamp: 123,
                    queueType: "followUp",
                  },
                ]
              : [],
        },
      });

      await vi.advanceTimersByTimeAsync(10_000);

      await expect(submitted).resolves.toBe(false);
      expect(requestSignal?.aborted).toBe(true);
      expect(bridge.queuedUserMessages).toMatchObject([
        { text: "authoritative queued message", queueType },
      ]);
      expect(bridge.notifications.at(-1)).toMatchObject({
        notifyType: "error",
        message: expect.stringMatching(/10|超时|timed out/i),
      });

      bridge.disconnect();
    },
  );
});
