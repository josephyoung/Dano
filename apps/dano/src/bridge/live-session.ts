/**
 * Abstractions over Pi's live-session runtime.
 *
 * These interfaces allow the bridge RPC adapter to remain agnostic to
 * ExtensionAPI / ExtensionCommandContext while still consuming events,
 * reading state, and issuing actions against the live Pi session.
 *
 * Dano backend code adapts concrete Pi session objects. A future backend
 * would provide its own implementation.
 */

import type {
  AgentSession,
  AgentSessionEvent,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { RpcSlashCommand } from "../../types/protocol.js";

// ============================================================================
// 1. BridgeSessionEvents  — subscribe to live-session lifecycle events
// ============================================================================

/** Discriminated-union event type for Pi agent session events. */
type PiLiveEventType =
  | "agent_start"
  | "agent_end"
  | "auto_retry_start"
  | "auto_retry_end"
  | "message_start"
  | "message_update"
  | "message_end";

type PiLiveEvent = Extract<AgentSessionEvent, { type: PiLiveEventType }>;
type PiAgentEndEvent = Extract<PiLiveEvent, { type: "agent_end" }>;
type PiAutoRetryStartEvent = Extract<
  PiLiveEvent,
  { type: "auto_retry_start" }
>;
type PiAutoRetryEndEvent = Extract<PiLiveEvent, { type: "auto_retry_end" }>;

export type BridgeLiveEvent =
  | Exclude<
      PiLiveEvent,
      PiAgentEndEvent | PiAutoRetryStartEvent | PiAutoRetryEndEvent
    >
  | (Pick<PiAgentEndEvent, "type"> &
      Partial<Pick<PiAgentEndEvent, "messages" | "willRetry">>)
  | Pick<
      PiAutoRetryStartEvent,
      "type" | "attempt" | "maxAttempts" | "delayMs"
    >
  | Pick<PiAutoRetryEndEvent, "type" | "success">
  | { type: "session_compact" }
  | {
      type: "model_select";
      model: Model<Api>;
      previousModel?: Model<Api>;
      source: "set" | "cycle" | "restore";
    };

export type BridgeLiveEventHandler = (event: BridgeLiveEvent) => void;

export interface BridgeSessionEvents {
  /** Register a handler for any live-session event. Returns unsubscribe. */
  subscribe(handler: BridgeLiveEventHandler): () => void;
}

// ============================================================================
// 2. BridgeSessionState  — read-only access to the live session
// ============================================================================

export interface BridgeSessionState {
  /** The session manager for the live (TUI-attached) session. */
  readonly sessionManager: SessionManager;

  /** Current working directory. */
  cwd: string;

  /** True when the live agent is idle (not streaming). */
  isIdle(): boolean;

  /** True while Pi is compacting the live session context. */
  isCompacting(): boolean;

  /** Number of queued messages reported by the live Pi session. */
  getPendingMessageCount(): number;

  /** Available model registry. */
  getAvailableModels(): Model<Api>[];

  /** The currently-selected model (from the live session). */
  getCurrentModel: () => Model<Api> | undefined;

  /** Default model configured by Pi SettingsManager, when resolvable. */
  getConfiguredDefaultModel(): Model<Api> | undefined;

  /** Default thinking level configured by Pi SettingsManager. */
  getConfiguredDefaultThinkingLevel(): ReturnType<
    SettingsManager["getDefaultThinkingLevel"]
  >;

  /** Current thinking level. */
  getThinkingLevel(): AgentSession["thinkingLevel"];

  /** Context-usage stats (tokens, contextWindow, percent). */
  getContextUsage(): ReturnType<AgentSession["getContextUsage"]> | null;
}

// ============================================================================
// 3. BridgeSessionActions  — write / action operations on the live session
// ============================================================================

/** Content for a user message sent through the live session. */
export type BridgeUserMessageContent = Parameters<
  AgentSession["sendUserMessage"]
>[0];

export interface BridgeSessionActions {
  /** Send a user message to the live session (steer or follow-up). */
  sendUserMessage(
    content: BridgeUserMessageContent,
    options: { deliverAs: "steer" | "followUp" },
  ): void;

  /** Abort the current agent turn. */
  abort(): void;

  /** Abort Pi's active context compaction. */
  abortCompaction(): void;

  /** Set the active model. */
  setModel(
    model: Pick<Parameters<AgentSession["setModel"]>[0], "id" | "provider">,
  ): Promise<void>;

  /** Set the thinking level. */
  setThinkingLevel(level: Parameters<AgentSession["setThinkingLevel"]>[0]): void;

  /** Set the session display name. */
  setSessionName(name: Parameters<AgentSession["setSessionName"]>[0]): void;

  /** List registered slash commands. */
  getCommands(session?: AgentSession): RpcSlashCommand[];
}
