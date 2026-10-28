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

describe("bridge thinking mode", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); eventSources.length = 0; });
  it("uses the effective level returned by the server instead of the requested level", async () => {
    const bridge = await connectBridge();
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const command = JSON.parse(String(init?.body)).payload;
      queueMicrotask(() => eventSources[0]!.send({type:"response",payload:{id:command.id,type:"response",command:command.type,success:true,data:{level:"high"}}}));
      return new Response(null,{status:202});
    });
    try { await bridge.setThinkingLevel("medium"); expect(bridge.currentThinkingLevel).toBe("high"); }
    finally { bridge.disconnect(); }
  });
  it("resynchronizes actual state after an uncertain transport failure", async () => {
    const bridge = await connectBridge();
    let reads = 0;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const command = JSON.parse(String(init?.body)).payload;
      if (command.type === "set_thinking_level") throw new Error("connection lost after apply");
      if (command.type === "get_state") { reads++; queueMicrotask(() => eventSources[0]!.send({type:"response",payload:{id:command.id,type:"response",command:"get_state",success:true,data:{thinkingLevel:"high",sessionId:"session-1",isStreaming:false}}})); }
      return new Response(null,{status:202});
    });
    try { await bridge.setThinkingLevel("medium"); expect(reads).toBe(1); expect(bridge.currentThinkingLevel).toBe("high"); expect(bridge.notifications.at(-1)?.message).toBe("无法切换回答模式"); }
    finally { bridge.disconnect(); }
  });
  it("ignores the old response when the user selects another session", async () => {
    const bridge = await connectBridge();
    const events = eventSources[0]!;
    const store = await import("./bridgeStore.svelte");
    const state = (file: string) => store.applyNewSessionResponse({type:"response",command:"new_session",success:true,data:{cancelled:false,treeEntries:[],sessionName:"",sessionPath:file,sessionId:file,thinkingLevel:"off",transcript:{sessionPath:file,messages:[],hasOlder:false,hasNewer:false}}});
    state("/session-a");
    let command: {id: string; type: string} | undefined;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {command = JSON.parse(String(init?.body)).payload;return new Response(null,{status:202});});
    try {
      const change = bridge.setThinkingLevel("medium");
      await vi.waitFor(() => expect(command?.type).toBe("set_thinking_level"));
      state("/session-b");
      events.send({type:"response",payload:{id:command!.id,type:"response",command:"set_thinking_level",success:true,data:{level:"high"}}});
      await change; expect(bridge.currentThinkingLevel).toBe("off");
    } finally {bridge.disconnect();}
  });

});
