import type { RpcImageContent } from "@dano/types/protocol";

export interface HistoricalMessageRevisionPayload {
  entryId: string;
  text: string;
  images: RpcImageContent[];
}
