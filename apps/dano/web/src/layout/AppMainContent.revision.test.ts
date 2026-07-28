/** @vitest-environment happy-dom */

import { tick } from "svelte";
import { createClassComponent } from "svelte/legacy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoricalMessageRevisionPayload } from "../utils/messageRevision";
import AppMainContent from "./AppMainContent.svelte";

vi.mock("../composables/bridgeStore.svelte", () => ({
  abortGeneration: vi.fn(),
  answerQuestion: vi.fn(),
  cancelQuestionRevision: vi.fn(),
  getBridgeClientId: () => null,
  presentQuestion: vi.fn(),
  reviseQuestion: vi.fn(),
  submitQuestionRevision: vi.fn(),
}));

describe("AppMainContent historical-message editing", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("restores the Composer draft when the active message edit action cancels revision", async () => {
    const target = document.createElement("div");
    target.className = "app-shell";
    document.body.appendChild(target);
    let component: ReturnType<typeof createClassComponent>;
    const onCancelRevision = vi.fn(() => {
      component.$set({ pendingRevision: null });
    });
    const onReviseMessage = vi.fn((payload: HistoricalMessageRevisionPayload) => {
      component.$set({ pendingRevision: payload });
    });

    component = createClassComponent({
      component: AppMainContent,
      target,
      props: {
        activeSessionPath: "/sessions/history.jsonl",
        connectionStatus: "connected",
        allowRevision: true,
        transcript: [{
          id: "historical-user-message",
          role: "user",
          content: "historical message",
        }] as never,
        editQueuedPayload: {
          text: "draft before editing",
          images: [{ type: "image", data: "ZHJhZnQ=", mimeType: "image/png" }],
        },
        onReviseMessage,
        onCancelRevision,
      },
    });

    try {
      await tick();
      const textarea = target.querySelector<HTMLTextAreaElement>("textarea");
      expect(textarea?.value).toBe("draft before editing");
      expect(target.querySelector('button[aria-label="查看 image-1.png"]'))
        .not.toBeNull();

      target.querySelector<HTMLButtonElement>(
        'button[aria-label="编辑消息"]',
      )?.click();
      await tick();

      expect(onReviseMessage).toHaveBeenCalledWith({
        entryId: "historical-user-message",
        text: "historical message",
        images: [],
      });
      expect(textarea?.value).toBe("historical message");

      if (textarea) {
        textarea.value = "changed historical message";
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
      target.querySelector<HTMLButtonElement>(
        'button[aria-label="取消编辑"]',
      )?.click();
      await tick();

      expect(onCancelRevision).toHaveBeenCalledTimes(1);
      expect(textarea?.value).toBe("draft before editing");
      expect(target.querySelector('button[aria-label="查看 image-1.png"]'))
        .not.toBeNull();
    } finally {
      component.$destroy();
      target.remove();
    }
  });
});
