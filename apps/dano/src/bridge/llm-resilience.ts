import type {
  AgentSession,
  AgentSessionEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const ASSISTANT_TURN_BUDGET_MS = 15 * 60_000;

const READ_ONLY_TOOLS = new Set(["read", "get_dano_version"]);

function hasVisibleAssistantOutput(event: AgentSessionEvent): boolean {
  if (event.type !== "message_update" || event.message.role !== "assistant") {
    return false;
  }

  return event.message.content.some(block => {
    if (block.type === "text") return block.text.trim().length > 0;
    if (block.type === "thinking") return block.thinking.trim().length > 0;
    return false;
  });
}

export function configureDanoLlmResilience(
  settingsManager: SettingsManager,
  session: AgentSession,
): () => void {
  let retryEnabledBeforeSuppression = true;
  let retrySuppressed = false;
  let assistantTurnTimer: ReturnType<typeof setTimeout> | undefined;

  const restoreRetrySetting = () => {
    if (!retrySuppressed) return;
    settingsManager.applyOverrides({
      retry: { enabled: retryEnabledBeforeSuppression },
    });
    retrySuppressed = false;
  };

  const suppressRetry = () => {
    if (retrySuppressed) return;
    retryEnabledBeforeSuppression = settingsManager.getRetryEnabled();
    if (!retryEnabledBeforeSuppression) return;
    settingsManager.applyOverrides({ retry: { enabled: false } });
    retrySuppressed = true;
  };

  const clearAssistantTurnTimer = () => {
    if (!assistantTurnTimer) return;
    clearTimeout(assistantTurnTimer);
    assistantTurnTimer = undefined;
  };

  const startAssistantTurnTimer = () => {
    clearAssistantTurnTimer();
    assistantTurnTimer = setTimeout(() => {
      assistantTurnTimer = undefined;
      void session.abort().catch(error => {
        console.error("Failed to abort expired Assistant Turn:", error);
      });
    }, ASSISTANT_TURN_BUDGET_MS);
    assistantTurnTimer.unref?.();
  };

  const unsubscribe = session.subscribe(event => {
    if (event.type === "message_start" && event.message.role === "user") {
      restoreRetrySetting();
      startAssistantTurnTimer();
      return;
    }

    if (event.type === "agent_settled") {
      clearAssistantTurnTimer();
      return;
    }

    if (hasVisibleAssistantOutput(event)) {
      suppressRetry();
      return;
    }

    if (
      event.type === "tool_execution_start" &&
      !READ_ONLY_TOOLS.has(event.toolName)
    ) {
      suppressRetry();
    }
  });

  return () => {
    clearAssistantTurnTimer();
    unsubscribe();
  };
}
