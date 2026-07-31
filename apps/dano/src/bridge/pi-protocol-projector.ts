import type { RpcModel } from "./types.js";

/** Keep Pi runtime-only model configuration out of the browser wire format. */
export function projectRpcModel(model: RpcModel): RpcModel {
  return {
    id: model.id,
    provider: model.provider,
    name: model.name,
    api: model.api,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}
