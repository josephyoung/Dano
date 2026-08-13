import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile as writeFileAtomically } from "atomically";
import type {
  OAuthProviderAdapter,
  ProviderCredential,
} from "../../bridge/oauth-provider.js";

export type RefreshPhaseKind = "success" | "cancel" | "confirm";
type PhaseKind = RefreshPhaseKind;
type TranscriptOutcome = "success" | "reauth_required";

export interface RefreshAcceptanceSessionCandidate {
  readonly id: string;
  readonly owner: string;
  readonly user: string;
  readonly workspace: string;
  readonly client: string;
  readonly firstSeen: number;
}

const SKILL_NAME = "provider-broker-release-gate";

export function refreshAcceptanceControlPage(): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>刷新验收浏览器绑定</title><style>body{font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem}form{display:grid;gap:1rem}button{min-height:3rem;padding:0 1.5rem}</style><h1>刷新验收浏览器绑定</h1><p>请在内置浏览器选择目标，在 Chrome 选择 Peer。</p><form method="post"><button name="role" value="target">设为目标浏览器</button><button name="role" value="peer">设为 Peer 浏览器</button></form></html>`;
}

export type RefreshArmFailureCode =
  | "login_sessions_unavailable"
  | "credentials_unavailable"
  | "provider_validation_failed"
  | "phase_incomplete"
  | "credential_prepare_failed"
  | "unexpected_failure";

export type RefreshExecutionStage =
  | "credential_read"
  | "credential_missing"
  | "grant"
  | "identity"
  | "owner"
  | "record"
  | "evidence";

export function classifyRefreshExecutionFailure(
  stage: RefreshExecutionStage,
): string {
  return {
    credential_read: "credential_read_failed",
    credential_missing: "credential_missing",
    grant: "grant_failed",
    identity: "identity_failed",
    owner: "owner_mismatch",
    record: "record_write_failed",
    evidence: "producer_evidence_failed",
  }[stage];
}

export function createRefreshArmSingleFlight(
  run: (kind: RefreshPhaseKind) => Promise<void>,
): (kind: RefreshPhaseKind) => Promise<boolean> {
  let pending: Promise<void> | undefined;
  return async kind => {
    if (pending) return false;
    const current = run(kind);
    pending = current;
    try {
      await current;
      return true;
    } finally {
      if (pending === current) pending = undefined;
    }
  };
}

export async function selectRefreshAcceptanceSessions(
  candidates: readonly RefreshAcceptanceSessionCandidate[],
  targetId: string | undefined,
  peerId: string | undefined,
  readCredential: (id: string) => Promise<ProviderCredential | null>,
): Promise<
  | {
      target: RefreshAcceptanceSessionCandidate;
      peer: RefreshAcceptanceSessionCandidate;
      targetCredential: ProviderCredential;
      peerCredential: ProviderCredential;
    }
  | null
> {
  const active = (
    await Promise.all(
      [...candidates]
        .sort((left, right) => left.firstSeen - right.firstSeen)
        .map(async session => ({
          session,
          credential: await readCredential(session.id),
        })),
    )
  ).filter(
    (entry): entry is {
      session: RefreshAcceptanceSessionCandidate;
      credential: ProviderCredential;
    } => Boolean(entry.credential),
  );
  const target = active.find(entry => entry.session.id === targetId);
  const peer = active.find(entry => entry.session.id === peerId);
  if (
    !target ||
    !peer ||
    target.session.id === peer.session.id ||
    target.session.user !== peer.session.user
  ) return null;
  return {
    target: target.session,
    peer: peer.session,
    targetCredential: target.credential,
    peerCredential: peer.credential,
  };
}

export function classifyRefreshArmFailure(error: unknown): RefreshArmFailureCode {
  const message = error instanceof Error ? error.message : "";
  if (/browser sessions|login session/i.test(message)) {
    return "login_sessions_unavailable";
  }
  if (/previous refresh acceptance phase/i.test(message)) {
    return "phase_incomplete";
  }
  if (/stored atomically/i.test(message)) return "credential_prepare_failed";
  if (/provider/i.test(message)) return "provider_validation_failed";
  if (/credential/i.test(message)) return "credentials_unavailable";
  return "unexpected_failure";
}

export function createObservedAccessTokenInvalid(
  provider: Pick<OAuthProviderAdapter, "isAccessTokenInvalid">,
  observer: Pick<
    RealRefreshAcceptanceProducer,
    "observeProviderResponse"
  > & Partial<Pick<RealRefreshAcceptanceProducer, "observeEvidenceFailure">>,
): (response: Response) => Promise<boolean> {
  const isAccessTokenInvalid = provider.isAccessTokenInvalid;
  if (!isAccessTokenInvalid) {
    throw new Error("Provider invalid-token detection is unavailable");
  }
  return async response => {
    const invalid = await isAccessTokenInvalid(response);
    try {
      observer.observeProviderResponse(response.status, invalid);
    } catch {
      try {
        observer.observeEvidenceFailure?.();
      } catch {
        // The acceptance observer cannot change the provider decision.
      }
      // Evidence must fail closed without changing the Credential Broker result.
    }
    return invalid;
  };
}

export async function prepareInvalidAccessCredential(input: {
  recordPath: string;
  loginSessionId: string;
  credential: ProviderCredential;
  encryptionKey: { version: string; key: Uint8Array };
  beforeWrite?: (prepared: ProviderCredential) => void;
}): Promise<ProviderCredential> {
  if (!input.credential.refreshToken) {
    throw new Error("A real refresh Credential is required");
  }
  const record = JSON.parse(readFileSync(input.recordPath, "utf8")) as Record<
    string,
    unknown
  > & { status?: string; credential?: unknown };
  if (record.status !== "active" || !record.credential) {
    throw new Error("Active encrypted Login Session Credential is required");
  }
  const prepared: ProviderCredential = {
    ...input.credential,
    accessToken: `dano_refresh_acceptance_invalid_${randomBytes(32).toString("base64url")}`,
    expiresAt: 0,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", input.encryptionKey.key, iv);
  const sessionKey = createHash("sha256")
    .update(input.loginSessionId)
    .digest("hex");
  cipher.setAAD(
    Buffer.from(
      `dano-credential:v1:${input.encryptionKey.version}:${sessionKey}`,
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(prepared), "utf8"),
    cipher.final(),
  ]);
  input.beforeWrite?.(prepared);
  await writeFileAtomically(
    input.recordPath,
    `${JSON.stringify({
      ...record,
      credential: {
        algorithm: "aes-256-gcm",
        keyVersion: input.encryptionKey.version,
        iv: iv.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: cipher.getAuthTag().toString("base64url"),
      },
    })}\n`,
    { encoding: "utf8", mode: 0o600, fsync: true },
  );
  return prepared;
}

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
  preflight: boolean;
  invalidAccessPrepared: boolean;
  refreshGrant: boolean;
  refreshRejected: boolean;
  refreshIdentity: boolean;
  retryAccepted: boolean;
  peerCredential: boolean;
  peerAuthCurrent: boolean;
  evidenceFailed: boolean;
  targetUser?: string;
  peerUser?: string;
  peerOwner?: string;
  peerRecord?: string;
  peerCredentialBefore?: string;
  recordBefore?: string;
  credentialBefore?: string;
  credentialPrepared?: string;
}

export class RealRefreshAcceptanceProducer {
  private target?: {
    owner: string;
    client: string;
    workspace: string;
    user: string;
  };
  private peer?: { owner: string; client: string; user: string };
  private phase?: ActivePhase;

  constructor(private readonly now: () => number = Date.now) {}

  observeTargetClient(
    owner: string,
    client: string,
    workspace: string,
    user: string,
  ) {
    requireOpaque(owner, "Credential owner");
    requireOpaque(client, "Browser Client");
    requireOpaque(workspace, "Runtime Workspace");
    requireOpaque(user, "User");
    if (this.phase && this.phaseStatus().status !== "passed") {
      if (this.target?.owner !== owner) {
        throw new Error("Cannot replace the target Login Session during a phase");
      }
    }
    this.target = { owner, client, workspace, user };
  }

  observePeerClient(owner: string, client: string, user: string) {
    requireOpaque(owner, "Peer Credential owner");
    requireOpaque(client, "Peer Browser Client");
    requireOpaque(user, "Peer User");
    if (
      !this.target ||
      owner === this.target.owner ||
      client === this.target.client ||
      user !== this.target.user
    ) {
      throw new Error("Peer must be another Login Session for the same User");
    }
    this.peer = { owner, client, user };
  }

  arm(kind: PhaseKind): string {
    if (this.phase && this.phaseStatus().status !== "passed") {
      throw new Error("The previous refresh acceptance phase is incomplete");
    }
    if (!this.target || !this.peer) {
      throw new Error("Two same-User authenticated Login Sessions are required");
    }
    const marker =
      `refresh-${kind}-${this.now()}-${randomBytes(8).toString("hex")}`;
    this.phase = {
      kind,
      marker,
      owner: this.target.owner,
      authenticatedWorkspace: this.target.workspace,
      invalidated: false,
      refreshStarted: false,
      refreshFinished: false,
      reauthentication: false,
      transcript: false,
      authCurrent: false,
      action: false,
      anonymous: false,
      preflight: false,
      invalidAccessPrepared: false,
      refreshGrant: false,
      refreshRejected: false,
      refreshIdentity: false,
      retryAccepted: false,
      peerCredential: false,
      peerAuthCurrent: false,
      evidenceFailed: false,
    };
    return marker;
  }

  abortPhase(marker: string): boolean {
    if (!this.phase || this.phase.marker !== marker) return false;
    if (this.phaseStatus().status === "passed") return false;
    this.phase = undefined;
    return true;
  }

  observePreflight(
    owner: string,
    targetUser: string,
    peerOwner: string,
    peerUser: string,
    peerRecord: string,
    peerCredential: string,
  ) {
    const phase = this.requiredPhase();
    this.sameOwner(owner, phase);
    if (peerOwner !== this.peer?.owner || peerOwner === owner) {
      throw new Error("Peer Login Session is invalid");
    }
    for (const [value, label] of [
      [targetUser, "Target User"],
      [peerUser, "Peer User"],
      [peerRecord, "Peer Credential record"],
      [peerCredential, "Peer Credential content"],
    ] as const) {
      requireOpaque(value, label);
    }
    if (
      targetUser !== this.target?.user ||
      peerUser !== this.peer?.user ||
      targetUser !== peerUser
    ) {
      throw new Error(
        "Provider validation must match the browsers' canonical User",
      );
    }
    phase.preflight = true;
    phase.targetUser = targetUser;
    phase.peerUser = peerUser;
    phase.peerOwner = peerOwner;
    phase.peerRecord = peerRecord;
    phase.peerCredentialBefore = peerCredential;
  }

  observeInvalidAccessPrepared(
    owner: string,
    credentialBefore: string,
    credentialPrepared: string,
    refreshGrantBefore: string,
    refreshGrantPrepared: string,
  ) {
    const phase = this.requiredPhase();
    this.sameOwner(owner, phase);
    for (const [value, label] of [
      [credentialBefore, "Credential before invalid access preparation"],
      [credentialPrepared, "Prepared Credential"],
      [refreshGrantBefore, "Refresh grant before preparation"],
      [refreshGrantPrepared, "Refresh grant after preparation"],
    ] as const) {
      requireOpaque(value, label);
    }
    if (
      !phase.preflight ||
      phase.invalidAccessPrepared ||
      credentialBefore === credentialPrepared ||
      refreshGrantBefore !== refreshGrantPrepared
    ) {
      throw new Error(
        "Invalid access preparation must change only the access Credential and preserve the real refresh grant",
      );
    }
    phase.invalidAccessPrepared = true;
    phase.credentialPrepared = credentialPrepared;
  }

  observeProviderResponse(status: number, accessTokenInvalid: boolean) {
    const phase = this.requiredPhase();
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw new Error("Provider response status is invalid");
    }
    if (!phase.invalidated) {
      if (!phase.invalidAccessPrepared || !accessTokenInvalid) {
        throw new Error("A prepared invalid access Credential and real provider rejection are required");
      }
      phase.invalidated = true;
      return;
    }
    if (!phase.refreshFinished) {
      throw new Error("Provider retry occurred before refresh completed");
    }
    if (phase.kind !== "success" || accessTokenInvalid) {
      throw new Error("Provider retry did not accept the refreshed Credential");
    }
    phase.retryAccepted = true;
  }

  observeEvidenceFailure() {
    this.requiredPhase().evidenceFailed = true;
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
    if (
      !phase.invalidated ||
      phase.refreshStarted ||
      credentialBefore !== phase.credentialPrepared
    ) {
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
      !phase.refreshGrant ||
      !phase.refreshIdentity ||
      phase.recordBefore === recordAfter ||
      phase.credentialBefore === credentialAfter
    ) {
      throw new Error("Refresh must atomically rotate the same Credential owner");
    }
    phase.refreshFinished = true;
  }

  observeRefreshGrant(owner: string, credentialAfter: string) {
    const phase = this.requiredPhase();
    this.sameOwner(owner, phase);
    requireOpaque(credentialAfter, "Refreshed Credential content");
    if (
      phase.kind !== "success" ||
      !phase.refreshStarted ||
      phase.credentialBefore === credentialAfter
    ) {
      throw new Error("Real refresh grant is invalid or out of order");
    }
    phase.refreshGrant = true;
  }

  observeRefreshValidatedUser(owner: string, user: string) {
    const phase = this.requiredPhase();
    this.sameOwner(owner, phase);
    requireOpaque(user, "Refreshed User");
    if (!phase.refreshGrant || user !== phase.targetUser) {
      throw new Error("Refreshed Credential identity changed");
    }
    phase.refreshIdentity = true;
  }

  observeRefreshFailure(owner: string) {
    const phase = this.requiredPhase();
    this.sameOwner(owner, phase);
    if (
      phase.kind === "success" ||
      !phase.refreshStarted ||
      !phase.refreshRejected
    ) {
      throw new Error("Refresh failure is out of order");
    }
    phase.refreshFinished = true;
  }

  observeRefreshRejection(owner: string) {
    const phase = this.requiredPhase();
    this.sameOwner(owner, phase);
    if (phase.kind === "success" || !phase.refreshStarted || phase.refreshGrant) {
      throw new Error("Real refresh rejection is invalid or out of order");
    }
    phase.refreshRejected = true;
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

  observePeerCredential(
    owner: string,
    user: string,
    record: string,
    credential: string,
  ) {
    const phase = this.requiredPhase();
    if (
      !phase.refreshFinished ||
      owner !== phase.peerOwner ||
      user !== phase.peerUser ||
      record !== phase.peerRecord ||
      credential !== phase.peerCredentialBefore
    ) {
      throw new Error("Peer Login Session or Credential changed");
    }
    phase.peerCredential = true;
  }

  observeAuthCurrent(
    owner: string,
    status: "authenticated" | "reauth_required",
  ) {
    const phase = this.requiredPhase();
    if (owner === phase.peerOwner) {
      if (!phase.peerCredential || status !== "authenticated") {
        throw new Error("Peer public auth state is invalid or out of order");
      }
      phase.peerAuthCurrent = true;
      return;
    }
    this.sameOwner(owner, phase);
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
        ? phase.refreshFinished &&
          phase.refreshGrant &&
          phase.refreshIdentity &&
          phase.retryAccepted &&
          phase.transcript &&
          phase.authCurrent &&
          phase.peerCredential &&
          phase.peerAuthCurrent
        : phase.kind === "cancel"
          ? phase.refreshFinished &&
            phase.reauthentication &&
            phase.transcript &&
            phase.authCurrent &&
            phase.action &&
            phase.anonymous &&
            phase.peerCredential &&
            phase.peerAuthCurrent
          : phase.refreshFinished &&
            phase.reauthentication &&
            phase.transcript &&
            phase.authCurrent &&
            phase.action &&
            phase.peerCredential &&
            phase.peerAuthCurrent;
    return {
      kind: phase.kind,
      status: passed && !phase.evidenceFailed ? "passed" : "pending",
    };
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
