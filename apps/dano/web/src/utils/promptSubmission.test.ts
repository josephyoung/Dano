import type { RpcImageContent, RpcUploadedFileRef } from "@dano/types/protocol";
import { describe, expect, it, vi } from "vitest";
import { submitConversationPrompt } from "./promptSubmission";

const images: RpcImageContent[] = [
  { type: "image", data: "aGlzdG9yaWNhbA==", mimeType: "image/jpeg" },
];
const files: RpcUploadedFileRef[] = [];

describe("submitConversationPrompt", () => {
  it("navigates to the historical node before resending the edited payload", async () => {
    const calls: string[] = [];
    const navigateTree = vi.fn(async (entryId: string) => {
      calls.push(`navigate:${entryId}`);
      return { success: true };
    });
    const onAccepted = vi.fn();
    const sendPrompt = vi.fn(async (
      message: string,
      submittedImages: RpcImageContent[],
      submittedFiles: RpcUploadedFileRef[],
      mode: "followUp" | "steer",
    ) => {
      calls.push(`send:${message}`);
      expect(submittedImages).toEqual(images);
      expect(submittedFiles).toEqual(files);
      expect(mode).toBe("followUp");
      return true;
    });

    await expect(submitConversationPrompt({
      message: "edited historical message",
      images,
      files,
      revisionEntryId: "historical-node",
    }, { navigateTree, sendPrompt, onAccepted })).resolves.toBe(true);

    expect(calls).toEqual([
      "navigate:historical-node",
      "send:edited historical message",
    ]);
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["failed", { success: false }],
    ["cancelled", { success: true, cancelled: true }],
  ])("does not send when historical navigation is %s", async (_case, navigation) => {
    const sendPrompt = vi.fn(async () => true);
    const onAccepted = vi.fn();

    await expect(submitConversationPrompt({
      message: "edited historical message",
      images,
      files,
      revisionEntryId: "historical-node",
    }, {
      navigateTree: vi.fn(async () => navigation),
      sendPrompt,
      onAccepted,
    })).resolves.toBe(false);

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("retains the current edit when historical navigation rejects", async () => {
    const sendPrompt = vi.fn(async () => true);
    const onAccepted = vi.fn();

    await expect(submitConversationPrompt({
      message: "edited historical message",
      images,
      files,
      revisionEntryId: "historical-node",
    }, {
      navigateTree: vi.fn(async () =>
        Promise.reject(new Error("navigation failed"))),
      sendPrompt,
      onAccepted,
    })).resolves.toBe(false);

    expect(sendPrompt).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("retains the current edit when prompt dispatch is rejected", async () => {
    const onAccepted = vi.fn();

    await expect(submitConversationPrompt({
      message: "edited historical message",
      images,
      files,
      revisionEntryId: "historical-node",
    }, {
      navigateTree: vi.fn(async () => ({ success: true })),
      sendPrompt: vi.fn(async () => false),
      onAccepted,
    })).resolves.toBe(false);

    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("sends an ordinary prompt without historical navigation", async () => {
    const navigateTree = vi.fn(async () => ({ success: true }));
    const sendPrompt = vi.fn(async () => true);
    const onAccepted = vi.fn();

    await expect(submitConversationPrompt({
      message: "ordinary follow-up",
      images: [],
      files: [],
      steer: true,
    }, { navigateTree, sendPrompt, onAccepted })).resolves.toBe(true);

    expect(navigateTree).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledWith(
      "ordinary follow-up",
      [],
      [],
      "steer",
    );
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });
});
