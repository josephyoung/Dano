import { randomBytes } from "node:crypto";

type PhaseKind = "success" | "cancel" | "confirm";
type TranscriptOutcome = "success" | "reauth_required";

const SKILL_NAME = "provider-broker-release-gate";

interface ActivePhase {
  kind: PhaseKind;
  marker: string;
  owner: string;
  authenticatedWorkspace: string;
  invalidated: boolean;
  refreshStarted: boolean;
  refreshFinished: boolean;
  reauthentication: boolean;
  transcript: boolean;
  authCurrent: boolean;
  action: boolean;
  anonymous: boolean;
  recordBefore?: string;
  credentialBefore?: string;
}

export class RealRefreshAcceptanceProducer {
  private authenticated?: { owner: string; client: string; workspace: string };
  private phase?: ActivePhase;

  constructor(private readonly now: () => number = Date.now) {}

  observeAuthenticatedClient(owner: string, client: string, workspace: string) {
    requireOpaque(owner, "Credential owner");
    requireOpaque(client, "Browser Client");
    requireOpaque(workspace, "Runtime Workspace");
    this.authenticated = { owner, client, workspace };
  }

  arm(kind: PhaseKind): string {
    if (this.phase && this.phaseStatus().status !== "passed") {
      throw new Error("The previous refresh acceptance phase is incomplete");
    }
    if (!this.authenticated) {
      throw new Error("An authenticated Browser Client is required");
    }
    const marker =
      `refresh-${kind}-${this.now()}-${randomBytes(8).toString("hex")}`;
    this.phase = {
      kind,
      marker,
      owner: this.authenticated.owner,
      authenticatedWorkspace: this.authenticated.workspace,
      invalidated: false,
      refreshStarted: false,
      refreshFinished: false,
      reauthentication: false,
      transcript: false,
      authCurrent: false,
      action: false,
      anonymous: false,
    };
    return marker;
  }

  classifyProviderResponse(status: number): boolean {
    const phase = this.requiredPhase();
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error("Provider response status is invalid");
    }
    if (!phase.invalidated) {
      phase.invalidated = true;
      return true;
    }
    if (!phase.refreshFinished) {
      throw new Error("Provider retry occurred before refresh completed");
    }
    return status === 401;
  }

  observeRefreshStart(
    owner: string,
    recordBefore: string,
    credentialBefore: string,
  ) {
    const phase = this.requiredPhase();
    this.sameOwner(owner, phase);
    requireOpaque(recordBefore, "Credential record");
    requireOpaque(credentialBefore, "Credential content");
    if (!phase.invalidated || phase.refreshStarted) {
      throw new Error("Refresh start is out of order");
    }
    phase.refreshStarted = true;
    phase.recordBefore = recordBefore;
    phase.credentialBefore = credentialBefore;
  }

  observeRefreshSuccess(
    owner: string,
    recordAfter: string,
    credentialAfter: string,
  ) {
    const phase = this.requiredPhase();
    this.sameOwner(owner, phase);
    requireOpaque(recordAfter, "Credential record");
    requireOpaque(credentialAfter, "Credential content");
    if (
      phase.kind !== "success" ||
      !phase.refreshStarted ||
      phase.recordBefore === recordAfter ||
      phase.credentialBefore === credentialAfter
    ) {
      throw new Error("Refresh must atomically rotate the same Credential owner");
    }
    phase.refreshFinished = true;
  }

  observeRefreshFailure(owner: string) {
    const phase = this.requiredPhase();
    this.sameOwner(owner, phase);
    if (phase.kind === "success" || !phase.refreshStarted) {
      throw new Error("Refresh failure is out of order");
    }
    phase.refreshFinished = true;
  }

  observeReauthentication(owner: string) {
    const phase = this.requiredPhase();
    this.sameOwner(owner, phase);
    if (phase.kind === "success" || !phase.refreshFinished) {
      throw new Error("Reauthentication projection is out of order");
    }
    phase.reauthentication = true;
  }

  observeTranscript(marker: string, outcome: TranscriptOutcome) {
    const phase = this.requiredPhase();
    if (marker !== phase.marker) {
      throw new Error("Pi transcript marker is invalid");
    }
    const expected = phase.kind === "success" ? "success" : "reauth_required";
    if (outcome !== expected || !phase.refreshFinished) {
      throw new Error("Pi transcript outcome is invalid");
    }
    phase.transcript = true;
  }

  observeAuthCurrent(status: "authenticated" | "reauth_required") {
    const phase = this.requiredPhase();
    const expected =
      phase.kind === "success" ? "authenticated" : "reauth_required";
    if (status !== expected || !phase.transcript) {
      throw new Error("Public auth state is invalid or out of order");
    }
    phase.authCurrent = true;
  }

  observeLogout(status: number, removedOwner: string) {
    const phase = this.requiredPhase();
    this.sameOwner(removedOwner, phase);
    if (phase.kind !== "cancel" || !phase.authCurrent || status !== 200) {
      throw new Error("AlertDialog cancel logout is invalid or out of order");
    }
    phase.action = true;
  }

  observeAnonymousClient(workspace: string) {
    const phase = this.requiredPhase();
    requireOpaque(workspace, "Anonymous Workspace");
    if (
      phase.kind !== "cancel" ||
      !phase.action ||
      workspace === phase.authenticatedWorkspace
    ) {
      throw new Error("AlertDialog cancel did not create an isolated Anonymous User");
    }
    phase.anonymous = true;
  }

  observeLoginRedirect(status: number, replacedOwner: string) {
    const phase = this.requiredPhase();
    this.sameOwner(replacedOwner, phase);
    if (
      phase.kind !== "confirm" ||
      !phase.authCurrent ||
      (status !== 302 && status !== 303)
    ) {
      throw new Error("AlertDialog confirm login redirect is invalid or out of order");
    }
    phase.action = true;
  }

  phaseStatus(): { kind: PhaseKind; status: "pending" | "passed" } {
    const phase = this.requiredPhase();
    const passed =
      phase.kind === "success"
        ? phase.refreshFinished && phase.transcript && phase.authCurrent
        : phase.kind === "cancel"
          ? phase.refreshFinished &&
            phase.reauthentication &&
            phase.transcript &&
            phase.authCurrent &&
            phase.action &&
            phase.anonymous
          : phase.refreshFinished &&
            phase.reauthentication &&
            phase.transcript &&
            phase.authCurrent &&
            phase.action;
    return { kind: phase.kind, status: passed ? "passed" : "pending" };
  }

  currentMarker(): string | undefined {
    return this.phase?.marker;
  }

  currentKind(): PhaseKind | undefined {
    return this.phase?.kind;
  }

  private requiredPhase(): ActivePhase {
    if (!this.phase) throw new Error("No refresh acceptance phase is armed");
    return this.phase;
  }

  private sameOwner(owner: string, phase: ActivePhase) {
    if (owner !== phase.owner) {
      throw new Error("Credential owner changed during refresh");
    }
  }
}

function requireOpaque(value: string, label: string) {
  if (!value || /[\s/:]/.test(value)) {
    throw new Error(`${label} fingerprint is invalid`);
  }
}

export function findRefreshAcceptanceTranscriptOutcome(
  entries: readonly unknown[],
  marker: string,
  expectedPath: string,
): TranscriptOutcome | null {
  const start = entries.findIndex(entry => {
    const message = messageOf(entry);
    const text = textOf(message?.content);
    return (
      message?.role === "user" &&
      text.includes(marker) &&
      (text.includes(`skill name="${SKILL_NAME}"`) ||
        text.includes(`/skill:${SKILL_NAME}`))
    );
  });
  if (start < 0) return null;

  const nextUser = entries.findIndex(
    (entry, index) => index > start && messageOf(entry)?.role === "user",
  );
  const turn = entries.slice(
    start + 1,
    nextUser < 0 ? entries.length : nextUser,
  );
  const calls = turn.flatMap((entry, index) =>
    toolCalls(messageOf(entry)).map(call => ({ call, index })),
  );
  if (
    calls.some(({ call }) => {
      if (call.name === "ask_user_question" || call.name === "provider_request") {
        return false;
      }
      if (call.name !== "read") return true;
      const args = callArguments(call);
      return (
        typeof args?.path !== "string" ||
        !args.path.endsWith(`/skills/${SKILL_NAME}/SKILL.md`)
      );
    })
  ) {
    return null;
  }

  const relevant = calls.filter(
    ({ call }) =>
      call.name === "ask_user_question" || call.name === "provider_request",
  );
  if (
    relevant.length !== 2 ||
    relevant[0]?.call.name !== "ask_user_question" ||
    relevant[1]?.call.name !== "provider_request"
  ) {
    return null;
  }

  const question = relevant[0];
  const questionArgs = callArguments(question.call);
  const provider = relevant[1];
  const providerArgs = callArguments(provider.call);
  if (
    !questionArgs ||
    Object.keys(questionArgs).length !== 5 ||
    questionArgs.question !== `Continue provider release gate ${marker}?` ||
    questionArgs.inputType !== "radio" ||
    questionArgs.required !== true ||
    questionArgs.default !== "continue" ||
    JSON.stringify(questionArgs.options) !==
      JSON.stringify([
        { id: "continue", label: "Continue" },
        { id: "stop", label: "Stop" },
      ]) ||
    !providerArgs ||
    Object.keys(providerArgs).length !== 2 ||
    providerArgs.method !== "GET" ||
    providerArgs.path !== expectedPath
  ) {
    return null;
  }

  const questionResult = matchingResult(
    turn,
    question.call.id,
    "ask_user_question",
  );
  const providerResult = matchingResult(
    turn,
    provider.call.id,
    "provider_request",
  );
  if (
    !questionResult ||
    questionResult.index <= question.index ||
    questionResult.index >= provider.index ||
    questionResult.message.isError === true ||
    record(questionResult.message.details)?.status !== "answered" ||
    record(questionResult.message.details)?.answer !== "continue" ||
    !providerResult ||
    providerResult.index <= provider.index
  ) {
    return null;
  }

  const details = record(providerResult.message.details);
  if (
    details?.ok === true &&
    Number.isInteger(details.status) &&
    Number(details.status) >= 200 &&
    Number(details.status) < 300
  ) {
    return "success";
  }
  const error = record(details?.error);
  return details?.ok === false && error?.code === "reauth_required"
    ? "reauth_required"
    : null;
}

interface TranscriptMessage {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  details?: unknown;
  isError?: unknown;
}

interface TranscriptToolCall {
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  args?: unknown;
}

function messageOf(entry: unknown): TranscriptMessage | null {
  const candidate = record(entry);
  const message = candidate?.type === "message" ? candidate.message : candidate;
  return record(message) as TranscriptMessage | null;
}

function toolCalls(message: TranscriptMessage | null): TranscriptToolCall[] {
  if (!message) return [];
  const direct = message as TranscriptMessage & {
    type?: unknown;
    name?: unknown;
  };
  if (direct.type === "toolCall") return [direct];
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter(
    (block): block is TranscriptToolCall => record(block)?.type === "toolCall",
  );
}

function callArguments(call: TranscriptToolCall): Record<string, unknown> | null {
  return record(call.arguments) ?? record(call.args);
}

function matchingResult(
  entries: readonly unknown[],
  callId: unknown,
  toolName: string,
): { message: TranscriptMessage; index: number } | null {
  if (typeof callId !== "string") return null;
  const matches = entries.flatMap((entry, index) => {
    const message = messageOf(entry);
    return message?.role === "toolResult" &&
      message.toolCallId === callId &&
      message.toolName === toolName
      ? [{ message, index }]
      : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  const object = record(value);
  return object ? Object.values(object).map(textOf).join("\n") : "";
}
