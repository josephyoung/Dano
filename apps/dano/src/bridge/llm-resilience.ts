import type {
  AgentSession,
  AgentSessionEvent,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_DANO_ASSISTANT_TURN_TIMEOUT_MS = 15 * 60_000;

const READ_ONLY_TOOLS = new Set(["read", "get_dano_version"]);

export function resolveDanoAssistantTurnTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = env.DANO_ASSISTANT_TURN_TIMEOUT_MS?.trim();
  if (!configured) return DEFAULT_DANO_ASSISTANT_TURN_TIMEOUT_MS;

  const timeoutMs = Number(configured);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(
      `Invalid DANO_ASSISTANT_TURN_TIMEOUT_MS: expected a positive integer, received ${JSON.stringify(configured)}`,
    );
  }
  return timeoutMs;
}

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
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const assistantTurnTimeoutMs = resolveDanoAssistantTurnTimeoutMs(env);
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
    }, assistantTurnTimeoutMs);
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
