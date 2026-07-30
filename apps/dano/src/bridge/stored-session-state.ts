import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RpcModel, RpcThinkingLevel } from "./types.js";

export function findLatestModelInfo(
  branch: readonly SessionEntry[],
): RpcModel | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "model_change") {
      return { provider: entry.provider, id: entry.modelId };
    }
  }

  return null;
}

export function findLatestThinkingLevelInfo(
  branch: readonly SessionEntry[],
): RpcThinkingLevel | null {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "thinking_level_change") continue;

    switch (entry.thinkingLevel) {
      case "off":
      case "minimal":
      case "low":
      case "medium":
      case "high":
      case "xhigh":
        return entry.thinkingLevel;
      default:
        return "off";
    }
  }

  return null;
}
