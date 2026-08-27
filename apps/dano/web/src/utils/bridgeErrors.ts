import { DANO_SESSION_PERSISTENCE_ERROR } from "../../../types/protocol";

interface BridgeErrorLabels {
  fallback: string;
  sessionPersistence: string;
  staleClient: string;
}

export function isStaleBridgeClientError(message: string): boolean {
  const normalized = message.trim();
  return normalized === "Client was not found" || normalized === "RECONNECT_REQUIRED";
}

export function bridgeServerErrorMessage(
  message: string,
  labels: BridgeErrorLabels,
): string {
  if (isStaleBridgeClientError(message)) return labels.staleClient;
  if (message.trim() === DANO_SESSION_PERSISTENCE_ERROR) {
    return labels.sessionPersistence;
  }
  return message || labels.fallback;
}

export function summarizeErrorMessage(message: string, fallback: string): string {
  const line = message
    .split(/\r?\n/)
    .map(part => part.trim())
    .find(Boolean);
  if (!line) return fallback;
  return line.length > 220 ? `${line.slice(0, 217)}...` : line;
}

export function bridgeCommandErrorNotificationMessage(
  event: { type?: unknown; error?: unknown },
  labels: Pick<BridgeErrorLabels, "fallback" | "sessionPersistence">,
): string | null {
  if (event.type !== "command_error") return null;
  if (event.error === DANO_SESSION_PERSISTENCE_ERROR) {
    return labels.sessionPersistence;
  }
  return summarizeErrorMessage(
    typeof event.error === "string" ? event.error : "",
    labels.fallback,
  );
}
