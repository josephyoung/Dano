/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";

describe("bridge compaction lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
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
});
