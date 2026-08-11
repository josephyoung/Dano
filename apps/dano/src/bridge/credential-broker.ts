import {
  defineTool,
  type AgentSessionEvent,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProviderCredential } from "./oauth-provider.js";

const AUTHENTICATION_REQUIRED = {
  ok: false,
  error: {
    code: "authentication_required",
    message: "Login is required for this provider request.",
  },
} as const;

const credentialBrokerParameters = Type.Object({
  method: Type.String(),
  path: Type.String(),
  headers: Type.Optional(Type.Record(Type.String(), Type.String())),
  body: Type.Optional(Type.Unknown()),
});

type ProviderRequestToolArguments = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
};

export function prepareProviderRequestArguments(
  input: unknown,
): ProviderRequestToolArguments {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { method: "", path: "" };
  }
  const raw = input as Record<string, unknown>;
  const headers = normalizeArgumentHeaders(raw.headers);
  return {
    method: typeof raw.method === "string" ? raw.method : "",
    path: typeof raw.path === "string" ? raw.path : "",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(raw.body === undefined ? {} : { body: raw.body }),
  };
}

export interface CredentialSession {
  readonly sessionId: string;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export interface ProviderRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export type ProviderResponse =
  | {
      readonly ok: true;
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly body: string;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "authentication_required" | "provider_request_failed";
        readonly message: string;
      };
    }
  | ProviderRequestInvalidResponse;

interface ProviderRequestInvalidResponse {
  readonly ok: false;
  readonly status: "invalid";
  readonly error: {
    readonly code: "invalid_provider_request";
    readonly category: "validation";
    readonly message: string;
    readonly retryable: true;
    readonly issues: readonly ProviderRequestIssue[];
  };
}

interface ProviderRequestIssue {
  readonly code:
    | "invalid_provider_method"
    | "invalid_provider_path"
    | "invalid_provider_body";
  readonly path: "method" | "path" | "body";
  readonly message: string;
}

export interface CredentialBrokerOptions {
  readonly providerApiOrigin: string;
  readonly readCredential: (
    loginSessionId: string,
  ) => Promise<ProviderCredential | null>;
  readonly fetch?: typeof fetch;
}

interface AssistantTurnBinding {
  readonly id: number;
  readonly loginSessionId?: string;
  queueEntry?: object;
}

export interface AssistantTurnBindingHandle {
  readonly scope: string;
  readonly agentSessionId: string;
  readonly id: number;
}

interface SessionBindings {
  readonly pending: AssistantTurnBinding[];
  enqueueTail?: Promise<void>;
  awaitingTurn?: AssistantTurnBinding;
  assistantTurn?: AssistantTurnBinding;
  activePiTurn?: AssistantTurnBinding;
  unsubscribe?: () => void;
}

const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "host",
  "proxy-authorization",
]);
const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "authorization",
  "proxy-authenticate",
  "set-cookie",
]);

export class CredentialBroker {
  private readonly providerApiOrigin: string;
  private readonly providerFetch: typeof fetch;
  private readonly sessions = new Map<
    string,
    Map<string, SessionBindings>
  >();
  private readonly queuedEntries = new WeakMap<
    object,
    AssistantTurnBindingHandle
  >();
  private nextBindingId = 1;

  constructor(private readonly options: CredentialBrokerOptions) {
    const providerApiOrigin = new URL(options.providerApiOrigin);
    if (providerApiOrigin.protocol !== "https:") {
      throw new Error("Provider API origin must use HTTPS");
    }
    this.providerApiOrigin = providerApiOrigin.origin;
    this.providerFetch = options.fetch ?? fetch;
  }

  observe(scope: string, session: CredentialSession): () => void {
    this.release(scope, session.sessionId);
    const state: SessionBindings = { pending: [] };
    const unsubscribe = session.subscribe(event => {
      this.handleSessionEvent(scope, session.sessionId, state, event);
    });
    state.unsubscribe = unsubscribe;
    let scopedSessions = this.sessions.get(scope);
    if (!scopedSessions) {
      scopedSessions = new Map();
      this.sessions.set(scope, scopedSessions);
    }
    scopedSessions.set(session.sessionId, state);
    return () => {
      if (this.sessionState(scope, session.sessionId) === state) {
        this.release(scope, session.sessionId);
      } else {
        unsubscribe();
      }
    };
  }

  queueAssistantTurn(
    scope: string,
    agentSessionId: string,
    loginSessionId: string | undefined,
  ): AssistantTurnBindingHandle | undefined {
    const state = this.sessionState(scope, agentSessionId);
    if (!state) return undefined;
    const binding = {
      id: this.nextBindingId++,
      ...(loginSessionId ? { loginSessionId } : {}),
    };
    state.pending.push(binding);
    return { scope, agentSessionId, id: binding.id };
  }

  associateQueuedAssistantTurn(
    handle: AssistantTurnBindingHandle | undefined,
    queueEntry: object | undefined,
  ): void {
    if (!handle || !queueEntry) return;
    const pending = this.sessionState(
      handle.scope,
      handle.agentSessionId,
    )?.pending;
    const binding = pending?.find(candidate => candidate.id === handle.id);
    if (!binding) return;
    binding.queueEntry = queueEntry;
    this.queuedEntries.set(queueEntry, handle);
  }

  async enqueueAssociatedAssistantTurn(
    handle: AssistantTurnBindingHandle | undefined,
    queuedEntries: () => readonly object[],
    enqueue: () => Promise<void>,
  ): Promise<void> {
    if (!handle) {
      await enqueue();
      return;
    }
    const state = this.sessionState(handle.scope, handle.agentSessionId);
    if (!state) {
      await enqueue();
      return;
    }
    const previous = state.enqueueTail ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    state.enqueueTail = tail;
    await previous;
    try {
      const before = new Set(queuedEntries());
      await enqueue();
      const queueEntry = queuedEntries().find(entry => !before.has(entry));
      if (queueEntry) {
        this.associateQueuedAssistantTurn(handle, queueEntry);
      } else {
        this.cancelQueuedAssistantTurn(handle);
      }
    } catch (error) {
      this.cancelQueuedAssistantTurn(handle);
      throw error;
    } finally {
      release();
      if (state.enqueueTail === tail) state.enqueueTail = undefined;
    }
  }

  cancelQueuedAssistantTurn(
    handle: AssistantTurnBindingHandle | undefined,
  ): void {
    if (!handle) return;
    const pending = this.sessionState(
      handle.scope,
      handle.agentSessionId,
    )?.pending;
    if (!pending) return;
    const index = pending.findIndex(binding => binding.id === handle.id);
    if (index >= 0) {
      const [removed] = pending.splice(index, 1);
      if (removed?.queueEntry) this.queuedEntries.delete(removed.queueEntry);
    }
  }

  cancelQueuedAssistantTurnForEntry(queueEntry: object | undefined): void {
    if (!queueEntry) return;
    const handle = this.queuedEntries.get(queueEntry);
    this.queuedEntries.delete(queueEntry);
    this.cancelQueuedAssistantTurn(handle);
  }

  clearQueuedAssistantTurns(scope: string, agentSessionId: string): void {
    const state = this.sessionState(scope, agentSessionId);
    if (!state) return;
    for (const binding of state.pending) {
      if (binding.queueEntry) this.queuedEntries.delete(binding.queueEntry);
    }
    state.pending.length = 0;
    state.awaitingTurn = undefined;
  }

  createTool(scope: string) {
    return defineTool({
      name: "provider_request",
      label: "Provider Request",
      description:
        "Send a generic authenticated request to the configured provider API without exposing its credential.",
      promptSnippet:
        "Use provider_request for provider API calls required by a Skill",
      promptGuidelines: [
        "Pass only a relative provider path plus method, headers, and body; do not request or supply credentials, user identities, Login Session identifiers, or an origin.",
      ],
      parameters: credentialBrokerParameters,
      prepareArguments: prepareProviderRequestArguments,
      executionMode: "sequential",
      execute: async (
        _toolCallId,
        request,
        signal,
        _onUpdate,
        context,
      ): Promise<AgentToolResult<ProviderResponse>> => {
        const response = await this.request(
          scope,
          context.sessionManager.getSessionId(),
          request,
          signal,
        );
        return {
          content: [{ type: "text", text: JSON.stringify(response) }],
          details: response,
          ...(response.ok ? {} : { isError: true }),
        };
      },
    });
  }

  async request(
    scope: string,
    agentSessionId: string,
    request: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse> {
    const issues: ProviderRequestIssue[] = [];
    const target =
      typeof request.path === "string"
        ? this.resolveTarget(request.path)
        : null;
    if (!target) {
      issues.push({
        code: "invalid_provider_path",
        path: "path",
        message: "Path must stay on the configured provider origin.",
      });
    }
    const method =
      typeof request.method === "string"
        ? request.method.trim().toUpperCase()
        : "";
    if (!method || !isHttpToken(method)) {
      issues.push({
        code: "invalid_provider_method",
        path: "method",
        message: "Method must be a valid HTTP token.",
      });
    }
    let body: string | undefined;
    try {
      body = requestBody(request.body);
    } catch {
      issues.push({
        code: "invalid_provider_body",
        path: "body",
        message: "Body must be JSON serializable or a string.",
      });
    }
    if (issues.length > 0) return invalidProviderRequest(issues);

    const binding = this.sessionState(scope, agentSessionId)?.activePiTurn;
    if (!binding?.loginSessionId) return AUTHENTICATION_REQUIRED;
    const credential = await this.options.readCredential(binding.loginSessionId);
    if (!credential) return AUTHENTICATION_REQUIRED;

    const headers = requestHeaders(request.headers, credential);
    if (body !== undefined && typeof request.body !== "string") {
      headers["content-type"] ??= "application/json";
    }
    try {
      const response = await this.providerFetch(target!, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "manual",
        signal,
      });
      const secrets = [credential.accessToken, credential.refreshToken].filter(
        (value): value is string => Boolean(value),
      );
      return {
        ok: true,
        status: response.status,
        headers: responseHeaders(response.headers, secrets),
        body: redactSecrets(await response.text(), secrets),
      };
    } catch {
      return {
        ok: false,
        error: {
          code: "provider_request_failed",
          message: "The provider request failed.",
        },
      };
    }
  }

  private handleSessionEvent(
    scope: string,
    agentSessionId: string,
    state: SessionBindings,
    event: AgentSessionEvent,
  ): void {
    if (event.type === "message_start" && event.message.role === "user") {
      const queueEntry = event.message as object;
      const associated = this.queuedEntries.get(queueEntry);
      const pendingIndex = associated
        ? state.pending.findIndex(
            binding =>
              binding.id === associated.id &&
              associated.scope === scope &&
              associated.agentSessionId === agentSessionId,
          )
        : state.pending.findIndex(binding => !binding.queueEntry);
      if (pendingIndex >= 0) {
        const [binding] = state.pending.splice(pendingIndex, 1);
        state.awaitingTurn = binding;
        if (binding?.queueEntry) this.queuedEntries.delete(binding.queueEntry);
      }
      return;
    }
    if (event.type === "turn_start") {
      if (state.awaitingTurn) {
        state.assistantTurn = state.awaitingTurn;
        state.awaitingTurn = undefined;
      }
      state.activePiTurn = state.assistantTurn;
      return;
    }
    if (event.type === "turn_end") {
      state.activePiTurn = undefined;
      return;
    }
    if (event.type === "agent_settled") {
      this.clearPending(state);
      state.awaitingTurn = undefined;
      state.assistantTurn = undefined;
      state.activePiTurn = undefined;
    }
  }

  private resolveTarget(relativePath: string): URL | null {
    if (!relativePath.startsWith("/") || relativePath.startsWith("//")) {
      return null;
    }
    try {
      const target = new URL(relativePath, this.providerApiOrigin);
      return target.origin === this.providerApiOrigin ? target : null;
    } catch {
      return null;
    }
  }

  private release(scope: string, agentSessionId: string): void {
    const scopedSessions = this.sessions.get(scope);
    const state = scopedSessions?.get(agentSessionId);
    scopedSessions?.delete(agentSessionId);
    if (scopedSessions?.size === 0) this.sessions.delete(scope);
    state?.unsubscribe?.();
    if (state) {
      this.clearPending(state);
      state.awaitingTurn = undefined;
      state.assistantTurn = undefined;
      state.activePiTurn = undefined;
    }
  }

  private clearPending(state: SessionBindings): void {
    for (const binding of state.pending) {
      if (binding.queueEntry) this.queuedEntries.delete(binding.queueEntry);
    }
    state.pending.length = 0;
  }

  private sessionState(
    scope: string,
    agentSessionId: string,
  ): SessionBindings | undefined {
    return this.sessions.get(scope)?.get(agentSessionId);
  }
}

function requestHeaders(
  input: Readonly<Record<string, string>> | undefined,
  credential: ProviderCredential,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    const normalizedName = name.trim().toLowerCase();
    if (!normalizedName || FORBIDDEN_REQUEST_HEADERS.has(normalizedName)) {
      continue;
    }
    headers[normalizedName] = value;
  }
  const scheme = credential.tokenType?.trim() || "Bearer";
  headers.authorization = `${scheme} ${credential.accessToken}`;
  return headers;
}

function normalizeArgumentHeaders(input: unknown): Record<string, string> {
  let value = input;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value.trim()) as unknown;
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (
      typeof headerValue === "string" ||
      typeof headerValue === "number" ||
      typeof headerValue === "boolean"
    ) {
      normalized[name] = String(headerValue);
    }
  }
  return normalized;
}

function requestBody(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input === "string") return input;
  return JSON.stringify(input);
}

function invalidProviderRequest(
  issues: readonly ProviderRequestIssue[],
): ProviderRequestInvalidResponse {
  return {
    ok: false,
    status: "invalid",
    error: {
      code: "invalid_provider_request",
      category: "validation",
      message: "Provider request arguments are invalid.",
      retryable: true,
      issues,
    },
  };
}

function responseHeaders(
  input: Headers,
  secrets: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {};
  input.forEach((value, name) => {
    const normalizedName = name.toLowerCase();
    if (FORBIDDEN_RESPONSE_HEADERS.has(normalizedName)) return;
    headers[normalizedName] = redactSecrets(value, secrets);
  });
  return headers;
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (!secret) continue;
    for (const representation of new Set([secret, encodeURIComponent(secret)])) {
      redacted = redacted.split(representation).join("[redacted]");
    }
  }
  return redacted;
}

function isHttpToken(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(value);
}
