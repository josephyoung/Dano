/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";

describe("transcript snapshot reconciliation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("preserves loaded older pages while replacing the overlapping latest window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );

    const store = await import("./bridgeStore.svelte");
    const bridge = store.initBridge();
    const loadedMessages = Array.from({ length: 101 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Message ${index}`,
    }));

    store.applyTranscriptSnapshotEvent({
      type: "transcript_snapshot",
      sessionPath: "/sessions/long.jsonl",
      messages: loadedMessages,
      hasOlder: false,
      hasNewer: false,
      oldestCursor: "i:0",
      newestCursor: "i:100",
    });

    store.applyTranscriptSnapshotEvent({
      type: "transcript_snapshot",
      sessionPath: "/sessions/long.jsonl",
      messages: loadedMessages.slice(21).map(message =>
        message.id === "message-100"
          ? { ...message, content: "Updated message 100" }
          : message,
      ),
      hasOlder: true,
      hasNewer: false,
      oldestCursor: "i:21",
      newestCursor: "i:100",
      preserveLoadedHistory: true,
    });

    expect(bridge.transcript).toHaveLength(101);
    expect(bridge.transcript.map(message => message.id)).toEqual(
      loadedMessages.map(message => message.id),
    );
    expect(bridge.transcript[100]?.content).toBe("Updated message 100");
    expect(bridge.transcriptHasOlder).toBe(false);
  });
});
