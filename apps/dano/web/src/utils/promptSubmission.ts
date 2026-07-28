import type { RpcImageContent, RpcUploadedFileRef } from "@dano/types/protocol";
import type { ComposerSubmissionPayload } from "./composerSubmission";

type SubmissionActions = {
  navigateTree: (entryId: string) => Promise<{
    success: boolean;
    cancelled?: boolean;
  }>;
  sendPrompt: (
    message: string,
    images: RpcImageContent[],
    files: RpcUploadedFileRef[],
    mode: "followUp" | "steer",
  ) => Promise<boolean>;
  onAccepted: () => void;
};

export async function submitConversationPrompt(
  payload: ComposerSubmissionPayload,
  actions: SubmissionActions,
): Promise<boolean> {
  if (payload.revisionEntryId) {
    try {
      const navigation = await actions.navigateTree(payload.revisionEntryId);
      if (!navigation.success || navigation.cancelled) return false;
    } catch {
      return false;
    }
  }

  const accepted = await actions.sendPrompt(
    payload.message,
    payload.images,
    payload.files,
    payload.steer ? "steer" : "followUp",
  );
  if (accepted) actions.onAccepted();
  return accepted;
}
