import type { RpcImageContent, RpcUploadedFileRef } from "@dano/types/protocol";

export interface ComposerSubmissionPayload {
  message: string;
  images: RpcImageContent[];
  files: RpcUploadedFileRef[];
  revisionEntryId?: string;
  steer?: boolean;
}
