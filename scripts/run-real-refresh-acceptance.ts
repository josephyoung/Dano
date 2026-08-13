#!/usr/bin/env -S node --import jiti/register
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { createAnonymousUserContextResolver } from "../apps/dano/src/bridge/anonymous-user-context.ts";
import { CredentialBroker } from "../apps/dano/src/bridge/credential-broker.ts";
import { createOAuthAuthentication } from "../apps/dano/src/bridge/oauth-authentication.ts";
import { createOAuth2ProviderAdapter } from "../apps/dano/src/bridge/oauth-provider.ts";
import type { ProviderCredential } from "../apps/dano/src/bridge/oauth-provider.ts";
import { DEFAULT_BRIDGE_CONFIG } from "../apps/dano/src/bridge/types.ts";
import { startDanoServer } from "../apps/dano/src/server.ts";
import {
  classifyRefreshArmFailure,
  createObservedAccessTokenInvalid,
  findRefreshAcceptanceTranscriptOutcome,
  prepareInvalidAccessCredential,
  RealRefreshAcceptanceProducer,
} from "../apps/dano/src/__tests__/support/real-refresh-acceptance-producer.ts";

const runtimeRootPath = resolve(required("DANO_RUNTIME_DIR"));
const sessionsRootPath = resolve(
  process.env.DANO_SESSIONS_ROOT?.trim() || join(runtimeRootPath, ".dano", "sessions"),
);
const providerApiOrigin = new URL(required("DANO_OAUTH_API_ORIGIN")).origin;
const providerPath = relativePath(required("DANO_PROVIDER_ACCEPTANCE_PATH"));
const appOrigin = new URL(required("DANO_OAUTH_REDIRECT_URI")).origin;
const tokenEndpoint = required("DANO_OAUTH_TOKEN_ENDPOINT");
const credentialKey = Buffer.from(required("DANO_OAUTH_CREDENTIAL_KEY"), "base64url");
if (credentialKey.byteLength !== 32) throw new Error("OAuth Credential key must be 32 bytes");
mkdirSync(sessionsRootPath, { recursive: true });

const headers = providerHeaders(process.env.DANO_OAUTH_PROVIDER_HEADERS_JSON);
const providerOptions = (clientSecret: string) => ({
  issuer: required("DANO_OAUTH_ISSUER"),
  authorizationEndpoint: required("DANO_OAUTH_AUTHORIZATION_ENDPOINT"),
  tokenEndpoint,
  identityEndpoint: required("DANO_OAUTH_IDENTITY_ENDPOINT"),
  clientId: required("DANO_OAUTH_CLIENT_ID"),
  clientSecret,
  scope: required("DANO_OAUTH_SCOPE"),
  requestHeaders: headers,
  sendStateToTokenEndpoint:
    process.env.DANO_OAUTH_SEND_STATE_TO_TOKEN_ENDPOINT?.trim() === "true",
  revocation: revocationOptions(tokenEndpoint),
  allowInsecureRequests: process.env.DANO_REFRESH_ACCEPTANCE_ALLOW_INSECURE === "true",
});
const provider = createOAuth2ProviderAdapter(
  providerOptions(required("DANO_OAUTH_CLIENT_SECRET")),
);
const failingProvider = createOAuth2ProviderAdapter(
  providerOptions(randomBytes(32).toString("base64url")),
);
const producer = new RealRefreshAcceptanceProducer();
let refreshMode: "normal" | "fail" = "normal";
let activeRefreshOwner: string | undefined;
let controller: Awaited<ReturnType<typeof startDanoServer>> | undefined;
let pendingAuthStatus: "authenticated" | "reauth_required" | undefined;
let pendingLogout: { status: number; owner: string } | undefined;
let pendingLogin: { status: number; owner: string } | undefined;
let pendingAnonymousWorkspace: string | undefined;
let pendingPeerCurrentOwner: string | undefined;
type ObservedLoginSession = {
  id: string;
  owner: string;
  user: string;
  workspace: string;
};
let targetSession: ObservedLoginSession | undefined;
let peerSession: ObservedLoginSession | undefined;
const pendingClientResolutions: Array<
  | ({ status: "authenticated" } & ObservedLoginSession)
  | { status: "anonymous"; workspace: string }
> = [];

const authentication = await createOAuthAuthentication({
  runtimeRootPath,
  appOrigin,
  redirectUri: required("DANO_OAUTH_REDIRECT_URI"),
  provider: {
    ...provider,
    async refreshCredential(credential) {
      const selected = refreshMode === "fail" ? failingProvider : provider;
      if (!selected.refreshCredential) throw new Error("Provider refresh is unavailable");
      let refreshed: ProviderCredential;
      try {
        refreshed = await selected.refreshCredential(credential);
      } catch (error) {
        if (activeRefreshOwner && refreshMode === "fail") {
          producer.observeRefreshRejection(activeRefreshOwner);
        }
        throw error;
      }
      if (activeRefreshOwner) {
        producer.observeRefreshGrant(
          activeRefreshOwner,
          credentialFingerprint(refreshed),
        );
      }
      return refreshed;
    },
    async validateCredential(credential) {
      if (!provider.validateCredential) {
        throw new Error("Provider identity validation is unavailable");
      }
      const identity = await provider.validateCredential(credential);
      return identity;
    },
  },
  credentialEncryptionKey: {
    version: required("DANO_OAUTH_CREDENTIAL_KEY_VERSION"),
    key: credentialKey,
  },
});

const observedAuthentication = {
  ...authentication,
  async resolveForClient(requestHeaders: IncomingHttpHeaders) {
    const resolution = await authentication.resolveForClient?.(requestHeaders);
    if (resolution?.authentication.status === "authenticated" && resolution.loginSessionId) {
      pendingClientResolutions.push({
        status: "authenticated",
        id: resolution.loginSessionId,
        owner: ownerFingerprint(resolution.loginSessionId),
        user: fingerprint(resolution.userContext.user.id),
        workspace: fingerprint(resolution.userContext.folderPath),
      });
    } else if (
      resolution?.authentication.status === "anonymous" &&
      producer.currentKind() === "cancel"
    ) {
      pendingClientResolutions.push({
        status: "anonymous",
        workspace: fingerprint(resolution.userContext.folderPath),
      });
    }
    return resolution ?? null;
  },
  async handle(req: Parameters<typeof authentication.handle>[0], res: ServerResponse, url: URL, lifecycle: Parameters<typeof authentication.handle>[3]) {
    const owner = cookieOwner(req.headers.cookie);
    const body = captureResponse(res);
    const handled = await authentication.handle(req, res, url, lifecycle);
    queueMicrotask(() => {
      const value = body.json();
      if (url.pathname === "/api/auth/current" && req.method === "GET") {
        const status = value?.status;
        if (
          owner &&
          (status === "authenticated" || status === "reauth_required")
        ) {
          if (owner === peerSession?.owner && status === "authenticated") {
            pendingPeerCurrentOwner = owner;
            void verifyPeerSession(owner);
          } else {
            pendingAuthStatus = status;
            applyPendingAuthStatus(owner);
          }
        }
      } else if (url.pathname === "/api/auth/logout" && req.method === "POST" && owner) {
        pendingLogout = { status: res.statusCode, owner };
        applyPendingAction();
      } else if (url.pathname === "/api/auth/login" && req.method === "GET" && owner) {
        pendingLogin = { status: res.statusCode, owner };
        applyPendingAction();
      }
    });
    return handled;
  },
};

const anonymousUsers = createAnonymousUserContextResolver({
  runtimeRootPath,
  secureCookie: false,
  authenticatedResolver: observedAuthentication,
  activityWriteIntervalMs: 0,
});

const broker = new CredentialBroker({
  providerApiOrigin: "https://refresh-acceptance.invalid",
  fetch: async (input, init = {}) => {
    const source = new URL(input instanceof Request ? input.url : String(input));
    const target = new URL(`${source.pathname}${source.search}`, providerApiOrigin);
    const requestHeaders = new Headers(headers);
    new Headers(init.headers).forEach((value, name) => requestHeaders.set(name, value));
    return fetch(target, { ...init, headers: requestHeaders });
  },
  readCredential: id => authentication.readProviderCredential(id),
  refreshCredential: async id => {
    const owner = ownerFingerprint(id);
    const credentialBefore = await authentication.readProviderCredential(id);
    if (!credentialBefore) return null;
    producer.observeRefreshStart(
      owner,
      loginRecordFingerprint(id),
      credentialFingerprint(credentialBefore),
    );
    activeRefreshOwner = owner;
    try {
      const refreshed = await authentication.refreshProviderCredential(id);
      if (!refreshed) {
        producer.observeRefreshFailure(owner);
        return null;
      }
      if (!targetSession || targetSession.owner !== owner) {
        throw new Error(
          "Refreshed Credential owner is not the target Login Session",
        );
      }
      producer.observeRefreshValidatedUser(owner, targetSession.user);
      producer.observeRefreshSuccess(
        owner,
        loginRecordFingerprint(id),
        credentialFingerprint(refreshed),
      );
      return refreshed;
    } catch {
      producer.observeRefreshFailure(owner);
      return null;
    } finally {
      activeRefreshOwner = undefined;
    }
  },
  isAccessTokenInvalid: createObservedAccessTokenInvalid(provider, producer),
  requireReauthentication: async id => {
    await authentication.requireReauthentication(id);
    producer.observeReauthentication(ownerFingerprint(id));
    controller?.requireReauthentication(id);
    void pollTranscript();
  },
});

controller = await startDanoServer(
  {
    ...DEFAULT_BRIDGE_CONFIG,
    host: "127.0.0.1",
    port: 8080,
    upload: { ...DEFAULT_BRIDGE_CONFIG.upload, uploadDir: join(runtimeRootPath, "uploads") },
  },
  {
    cwd: runtimeRootPath,
    sessionsRootPath,
    captureSigint: false,
    userContextResolver: anonymousUsers,
    anonymousUsers,
    authHttpHandler: observedAuthentication,
    credentialBroker: broker,
    danoConfig: {},
  },
);
controller.subscribe(event => {
  if (event.type !== "client_connect") return;
  const resolution = pendingClientResolutions.shift();
  if (!resolution) return;
  if (resolution.status === "authenticated") {
    observeLoginSession(resolution, fingerprint(event.client.id));
  } else {
    pendingAnonymousWorkspace = resolution.workspace;
    applyPendingAction();
  }
});

console.log("[refresh acceptance] ready; login in the in-app Browser first");
process.on("SIGUSR2", () => void arm("success"));
process.on("SIGURG", () => void arm("cancel"));
process.on("SIGWINCH", () => void arm("confirm"));
const transcriptTimer = setInterval(() => void pollTranscript(), 250);
transcriptTimer.unref();
const stop = async () => {
  clearInterval(transcriptTimer);
  await controller?.stop();
  await authentication.dispose();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

async function arm(kind: "success" | "cancel" | "confirm") {
  try {
    if (!targetSession || !peerSession) {
      throw new Error("Two authenticated browser sessions are required");
    }
    const [targetCredential, peerCredential] = await Promise.all([
      authentication.readProviderCredential(targetSession.id),
      authentication.readProviderCredential(peerSession.id),
    ]);
    if (!targetCredential || !peerCredential) {
      throw new Error("Both browser sessions need active Credentials");
    }
    if (!provider.validateCredential) {
      throw new Error("Provider validation is required");
    }
    await Promise.all([
      provider.validateCredential(targetCredential),
      provider.validateCredential(peerCredential),
    ]);
    refreshMode = kind === "success" ? "normal" : "fail";
    pendingAuthStatus = undefined;
    pendingLogout = undefined;
    pendingLogin = undefined;
    pendingAnonymousWorkspace = undefined;
    pendingPeerCurrentOwner = undefined;
    const marker = producer.arm(kind);
    producer.observePreflight(
      targetSession.owner,
      targetSession.user,
      peerSession.owner,
      peerSession.user,
      loginCredentialRecordFingerprint(peerSession.id),
      credentialFingerprint(peerCredential),
    );
    const prepared = await prepareInvalidAccessCredential({
      recordPath: join(
        runtimeRootPath,
        "auth",
        "login-sessions",
        `${ownerFingerprint(targetSession.id)}.json`,
      ),
      loginSessionId: targetSession.id,
      credential: targetCredential,
      encryptionKey: {
        version: required("DANO_OAUTH_CREDENTIAL_KEY_VERSION"),
        key: credentialKey,
      },
    });
    const storedPrepared = await authentication.readProviderCredential(
      targetSession.id,
    );
    if (
      !storedPrepared ||
      storedPrepared.accessToken !== prepared.accessToken ||
      storedPrepared.refreshToken !== targetCredential.refreshToken
    ) {
      throw new Error("Prepared Credential was not stored atomically");
    }
    producer.observeInvalidAccessPrepared(
      targetSession.owner,
      credentialFingerprint(targetCredential),
      credentialFingerprint(storedPrepared),
      refreshGrantFingerprint(targetCredential),
      refreshGrantFingerprint(storedPrepared),
    );
    console.log(
      `[refresh acceptance] ${kind} armed; invoke Skill with marker ${marker}`,
    );
  } catch (error) {
    const code = classifyRefreshArmFailure(error);
    console.error(
      `[refresh acceptance] ${kind} could not be armed; stage=${code}`,
    );
  }
}

async function pollTranscript() {
  const marker = producer.currentMarker();
  if (!marker) return;
  const outcome = findTranscriptOutcome(sessionsRootPath, marker, providerPath);
  if (!outcome) return;
  try {
    producer.observeTranscript(marker, outcome);
    if (targetSession) applyPendingAuthStatus(targetSession.owner);
    applyPendingAction();
    if (pendingPeerCurrentOwner) {
      void verifyPeerSession(pendingPeerCurrentOwner);
    }
    reportPhase();
  } catch {}
}

function applyPendingAuthStatus(owner: string) {
  if (!pendingAuthStatus) return;
  try {
    producer.observeAuthCurrent(owner, pendingAuthStatus);
    pendingAuthStatus = undefined;
    applyPendingAction();
    reportPhase();
  } catch {}
}

function applyPendingAction() {
  try {
    if (pendingLogout) {
      producer.observeLogout(pendingLogout.status, pendingLogout.owner);
      pendingLogout = undefined;
    }
    if (pendingLogin) {
      producer.observeLoginRedirect(pendingLogin.status, pendingLogin.owner);
      pendingLogin = undefined;
    }
    if (pendingAnonymousWorkspace) {
      producer.observeAnonymousClient(pendingAnonymousWorkspace);
      pendingAnonymousWorkspace = undefined;
    }
    reportPhase();
  } catch {}
}

function observeLoginSession(
  resolution: ObservedLoginSession,
  client: string,
) {
  if (!targetSession || targetSession.id === resolution.id) {
    targetSession = resolution;
    producer.observeTargetClient(
      resolution.owner,
      client,
      resolution.workspace,
      resolution.user,
    );
    return;
  }
  if (!peerSession || peerSession.id === resolution.id) {
    peerSession = resolution;
    producer.observePeerClient(resolution.owner, client, resolution.user);
    return;
  }
  if (resolution.id !== peerSession.id) {
    targetSession = resolution;
    producer.observeTargetClient(
      resolution.owner,
      client,
      resolution.workspace,
      resolution.user,
    );
  }
}

async function verifyPeerSession(owner: string) {
  try {
    if (!peerSession || owner !== peerSession.owner || !provider.validateCredential) {
      return;
    }
    const credential = await authentication.readProviderCredential(peerSession.id);
    if (!credential) return;
    await provider.validateCredential(credential);
    producer.observePeerCredential(
      owner,
      peerSession.user,
      loginCredentialRecordFingerprint(peerSession.id),
      credentialFingerprint(credential),
    );
    producer.observeAuthCurrent(owner, "authenticated");
    pendingPeerCurrentOwner = undefined;
    reportPhase();
  } catch {
    console.error("[refresh acceptance] peer Login Session verification failed");
  }
}

function reportPhase() {
  const phase = producer.phaseStatus();
  if (phase.status === "passed") console.log(`[refresh acceptance] ${phase.kind}: PASS`);
}

function findTranscriptOutcome(root: string, marker: string, expectedPath: string): "success" | "reauth_required" | null {
  for (const file of jsonlFiles(root)) {
    const entries = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const outcome = findRefreshAcceptanceTranscriptOutcome(
      entries,
      marker,
      expectedPath,
    );
    if (outcome) return outcome;
  }
  return null;
}

function jsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const target = join(root, entry.name);
    return entry.isDirectory() ? jsonlFiles(target) : entry.isFile() && entry.name.endsWith(".jsonl") ? [target] : [];
  });
}

function captureResponse(res: ServerResponse) {
  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = ((chunk: any, ...args: any[]) => { if (chunk) chunks.push(Buffer.from(chunk)); return originalWrite(chunk, ...args); }) as typeof res.write;
  res.end = ((chunk?: any, ...args: any[]) => { if (chunk) chunks.push(Buffer.from(chunk)); return originalEnd(chunk, ...args); }) as typeof res.end;
  return { json: () => { try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; } } };
}

function cookieOwner(cookie: string | undefined): string | null {
  const match = cookie?.match(/(?:^|;\s*)dano_login=([^;]+)/);
  return match?.[1] ? ownerFingerprint(decodeURIComponent(match[1])) : null;
}

function loginRecordFingerprint(id: string): string {
  return fingerprint(readFileSync(join(runtimeRootPath, "auth", "login-sessions", `${ownerFingerprint(id)}.json`)));
}
function loginCredentialRecordFingerprint(id: string): string {
  const record = JSON.parse(
    readFileSync(
      join(
        runtimeRootPath,
        "auth",
        "login-sessions",
        `${ownerFingerprint(id)}.json`,
      ),
      "utf8",
    ),
  ) as { credential?: unknown };
  if (!record.credential) throw new Error("Login Session Credential is unavailable");
  return fingerprint(JSON.stringify(record.credential));
}
function ownerFingerprint(value: string) { return fingerprint(value); }
function credentialFingerprint(value: unknown) { return fingerprint(JSON.stringify(value)); }
function refreshGrantFingerprint(value: ProviderCredential) {
  if (!value.refreshToken) throw new Error("Refresh Credential is unavailable");
  return fingerprint(value.refreshToken);
}
function fingerprint(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function relativePath(value: string) { const url = new URL(value, "https://invalid.test"); if (!value.startsWith("/") || value.startsWith("//") || url.origin !== "https://invalid.test") throw new Error("Provider path must be relative"); return `${url.pathname}${url.search}`; }
function providerHeaders(value: string | undefined) {
  if (!value?.trim()) return {};
  const parsed = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some(header => typeof header !== "string")
  ) {
    throw new Error("Provider headers must be a string-valued object");
  }
  return parsed as Record<string, string>;
}
function required(name: string) { const value = process.env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; }
function revocationOptions(endpoint: string) {
  const transport = required("DANO_OAUTH_REVOCATION_TRANSPORT");
  const configuredEndpoint = process.env.DANO_OAUTH_REVOCATION_ENDPOINT?.trim();
  if (transport === "rfc7009") {
    if (!configuredEndpoint) throw new Error("OAuth revocation endpoint is required");
    return { transport, endpoint: configuredEndpoint } as const;
  }
  if (transport === "delete-query-basic") {
    return {
      transport,
      endpoint: configuredEndpoint || endpoint,
    } as const;
  }
  throw new Error("OAuth revocation transport is unsupported");
}
