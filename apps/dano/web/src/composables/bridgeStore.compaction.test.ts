/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";

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

async function connectBridge() {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async input => {
      if (String(input) === "/api/clients") {
        return new Response(
          JSON.stringify({
            client: { id: "client-1" },
            eventsUrl: "/events",
            messagesUrl: "/messages",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 202 });
    }),
  );
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);

  const store = await import("./bridgeStore.svelte");
  const bridge = store.initBridge();
  await vi.waitFor(() => expect(eventSources).toHaveLength(1));
  eventSources[0]!.open();
  await vi.waitFor(() => expect(bridge.connectionStatus).toBe("connected"));
  return bridge;
}

describe("bridge compaction lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
    eventSources.length = 0;
  });

  it("tracks the native reason and hides raw failures from the transcript", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await import("./bridgeStore.svelte");
    const bridge = store.initBridge();

    store.applyCompactionStartEvent({
      type: "compaction_start",
      reason: "overflow",
    });
    expect(bridge.isCompacting).toBe(true);
    expect(bridge.compactionReason).toBe("overflow");

    store.applyCompactionEndEvent({
      type: "compaction_end",
      reason: "overflow",
      result: null,
      aborted: false,
      willRetry: false,
      errorMessage: "API quota exceeded for tenant secret-123",
    });

    expect(bridge.isCompacting).toBe(false);
    expect(bridge.compactionReason).toBeNull();
    expect(bridge.transcript.at(-1)?.errorMessage).toBe(
      "上下文压缩失败，请重试；若仍失败，请新建对话。",
    );
    expect(JSON.stringify(bridge.transcript)).not.toContain("secret-123");
    expect(consoleError).toHaveBeenCalledWith(
      "Context compaction failed:",
      "API quota exceeded for tenant secret-123",
    );
  });

  it("returns to idle when non-retrying compaction ends after a stale state response", async () => {
    const bridge = await connectBridge();
    const events = eventSources[0]!;

    events.send({
      type: "event",
      payload: { type: "agent_start", sessionPath: null },
    });
    events.send({
      type: "event",
      payload: { type: "agent_end", sessionPath: null },
    });
    events.send({
      type: "event",
      payload: { type: "compaction_start", reason: "threshold" },
    });
    events.send({
      type: "response",
      payload: {
        id: "stale-state",
        type: "response",
        command: "get_state",
        success: true,
        data: {
          thinkingLevel: "off",
          isStreaming: true,
          isCompacting: true,
          steeringMode: "all",
          followUpMode: "all",
          sessionId: "session-1",
          autoCompactionEnabled: true,
          messageCount: 2,
          pendingMessageCount: 0,
        },
      },
    });

    expect(bridge.isStreaming).toBe(true);
    expect(bridge.isCompacting).toBe(true);

    events.send({
      type: "event",
      payload: {
        type: "compaction_end",
        reason: "threshold",
        result: {
          summary: "summary",
          firstKeptEntryId: "message-2",
          tokensBefore: 6804,
        },
        aborted: false,
        willRetry: false,
      },
    });

    expect(bridge.isCompacting).toBe(false);
    expect(bridge.isStreaming).toBe(false);
    bridge.disconnect();
  });

  it("stays streaming while overflow compaction retries the prompt", async () => {
    const bridge = await connectBridge();
    const events = eventSources[0]!;

    events.send({
      type: "event",
      payload: { type: "agent_start", sessionPath: null },
    });
    events.send({
      type: "event",
      payload: { type: "compaction_start", reason: "overflow" },
    });
    events.send({
      type: "event",
      payload: {
        type: "compaction_end",
        reason: "overflow",
        result: {
          summary: "summary",
          firstKeptEntryId: "message-2",
          tokensBefore: 6804,
        },
        aborted: false,
        willRetry: true,
      },
    });

    expect(bridge.isCompacting).toBe(false);
    expect(bridge.isStreaming).toBe(true);
    bridge.disconnect();
  });
});
