import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import { writeFile as writeFileAtomically } from "atomically";
import { ensureSafeDirectory } from "./safe-directory.js";
import type {
  ExternalIdentity,
  OAuthProviderAdapter,
  ProviderCredential,
} from "./oauth-provider.js";
export type {
  ExternalIdentity,
  OAuthProviderAdapter,
  ProviderCredential,
} from "./oauth-provider.js";
import type { AuthHttpHandler, AuthHttpLifecycle } from "./server.js";
import {
  ensureUserFolder,
  toBrowserUserSummary,
  type AuthenticatedUser,
  type AuthenticatedUserContext,
  type AuthenticatedUserContextResolver,
} from "./user-context.js";

const FLOW_COOKIE_NAME = "dano_oauth_flow";
const LOGIN_COOKIE_NAME = "dano_login";
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_IDLE_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_GC_INTERVAL_MS = 60 * 60 * 1000;
const MAX_PENDING_TRANSACTIONS = 8;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface OAuthAuthenticationOptions {
  readonly runtimeRootPath: string;
  readonly appOrigin: string;
  readonly redirectUri: string;
  readonly provider: OAuthProviderAdapter;
  readonly credentialEncryptionKey: {
    readonly version: string;
    readonly key: Uint8Array;
  };
  readonly now?: () => number;
  readonly stateTtlMs?: number;
  readonly sessionGcIntervalMs?: number;
  readonly maxPendingTransactions?: number;
}

export interface OAuthAuthentication
  extends AuthenticatedUserContextResolver,
    AuthHttpHandler {
  dispose(): Promise<void>;
}

export async function createOAuthAuthentication(
  options: OAuthAuthenticationOptions,
): Promise<OAuthAuthentication> {
  const appOrigin = new URL(options.appOrigin).origin;
  const redirectUri = new URL(options.redirectUri);
  if (redirectUri.origin !== appOrigin) {
    throw new Error("OAuth redirect URI must use the configured Dano origin");
  }
  if (options.credentialEncryptionKey.key.byteLength !== 32) {
    throw new Error("OAuth credential encryption key must be 32 bytes");
  }
  const transactionsPath = path.resolve(
    options.runtimeRootPath,
    "auth",
    "login-transactions",
  );
  const sessionsPath = path.resolve(
    options.runtimeRootPath,
    "auth",
    "login-sessions",
  );
  const usersRootPath = path.resolve(options.runtimeRootPath, "users");
  await ensureSafeDirectory(transactionsPath, {
    recursive: true,
    unsafeDirectoryError: () =>
      new Error("OAuth login transaction directory is not safe"),
  });
  await ensureSafeDirectory(sessionsPath, {
    recursive: true,
    unsafeDirectoryError: () =>
      new Error("OAuth Login Session directory is not safe"),
  });
  await Promise.all([
    fs.promises.chmod(transactionsPath, 0o700),
    fs.promises.chmod(sessionsPath, 0o700),
  ]);
  const now = options.now ?? Date.now;
  const stateTtlMs = options.stateTtlMs ?? STATE_TTL_MS;
  const maxPendingTransactions =
    options.maxPendingTransactions ?? MAX_PENDING_TRANSACTIONS;
  await cleanupExpiredRecords(
    transactionsPath,
    sessionsPath,
    now(),
    stateTtlMs,
  );
  const cleanupInterval = setInterval(() => {
    void cleanupExpiredRecords(
      transactionsPath,
      sessionsPath,
      now(),
      stateTtlMs,
    ).catch(() => {});
  }, options.sessionGcIntervalMs ?? SESSION_GC_INTERVAL_MS);
  cleanupInterval.unref?.();
  const browserLocks = new Map<string, Promise<void>>();

  const loadSession = async (
    sessionId: string,
    touch: boolean,
  ): Promise<StoredLoginSession | null> => {
    if (!OPAQUE_ID_PATTERN.test(sessionId)) return null;
    const recordPath = loginSessionPath(sessionsPath, sessionId);
    let session: StoredLoginSession;
    try {
      session = parseLoginSession(await fs.promises.readFile(recordPath, "utf8"));
      decryptCredential(
        session.credential,
        options.credentialEncryptionKey,
        digest(sessionId),
      );
    } catch {
      await fs.promises.rm(recordPath, { force: true }).catch(() => {});
      return null;
    }
    const currentTime = now();
    if (
      currentTime - session.lastActiveAt >= SESSION_IDLE_TTL_MS ||
      currentTime >= session.absoluteExpiresAt
    ) {
      await fs.promises.rm(recordPath, { force: true }).catch(() => {});
      return null;
    }
    if (touch) {
      session = { ...session, lastActiveAt: currentTime };
      try {
        await writeLoginSession(recordPath, session);
      } catch {
        return null;
      }
    }
    return session;
  };

  const resolve = async (
    headers: http.IncomingHttpHeaders,
  ): Promise<AuthenticatedUserContext | null> => {
    return (await resolveLoginSession(headers))?.userContext ?? null;
  };

  const resolveLoginSession = async (
    headers: http.IncomingHttpHeaders,
  ): Promise<{
    loginSessionId: string;
    userContext: AuthenticatedUserContext;
  } | null> => {
    const sessionId = readCookie(headers.cookie, LOGIN_COOKIE_NAME);
    if (!sessionId) return null;
    const session = await loadSession(sessionId, true);
    if (!session) return null;
    return {
      loginSessionId: sessionId,
      userContext: {
        user: session.user,
        folderPath: await ensureUserFolder(usersRootPath, session.user.id),
      },
    };
  };

  return {
    resolve,
    async resolveForClient(headers) {
      const resolved = await resolveLoginSession(headers);
      return resolved
        ? {
            userContext: resolved.userContext,
            authentication: {
              status: "authenticated",
              user: toBrowserUserSummary(resolved.userContext.user),
            },
            loginSessionId: resolved.loginSessionId,
          }
        : null;
    },
    async resolveExisting(headers) {
      const resolved = await resolveLoginSession(headers);
      return resolved
        ? {
            userContext: resolved.userContext,
            authentication: {
              status: "authenticated",
              user: toBrowserUserSummary(resolved.userContext.user),
            },
            loginSessionId: resolved.loginSessionId,
          }
        : null;
    },
    async handle(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      url: URL,
      lifecycle: AuthHttpLifecycle,
    ): Promise<boolean> {
      if (req.method === "GET" && url.pathname === "/api/auth/current") {
        const current = await resolve(req.headers);
        writeJson(
          res,
          200,
          current
            ? {
                status: "authenticated",
                user: toBrowserUserSummary(current.user),
              }
            : { status: "anonymous" },
        );
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/auth/callback") {
        await handleCallback(req, res, url, {
          transactionsPath,
          sessionsPath,
          redirectUri: redirectUri.href,
          provider: options.provider,
          encryptionKey: options.credentialEncryptionKey,
          usersRootPath,
          now,
          stateTtlMs,
          lifecycle,
        });
        return true;
      }
      if (url.pathname === "/api/auth/logout") {
        if (req.method !== "POST") {
          writeJson(res, 405, { error: "Logout requires POST" });
          return true;
        }
        if (!sameOrigin(req.headers.origin, appOrigin)) {
          writeJson(res, 403, { error: "Logout origin is invalid" });
          return true;
        }
        const sessionId = readCookie(req.headers.cookie, LOGIN_COOKIE_NAME);
        if (sessionId) {
          const session = await loadSession(sessionId, false);
          if (session) {
            const credential = decryptCredential(
              session.credential,
              options.credentialEncryptionKey,
              digest(sessionId),
            );
            await fs.promises.rm(loginSessionPath(sessionsPath, sessionId), {
              force: true,
            });
            lifecycle.disconnectLoginSession(sessionId);
            await options.provider.revokeCredential?.(credential).catch(() => {});
          }
        }
        res.setHeader("Set-Cookie", serializeExpiredLoginCookie());
        writeJson(res, 200, { status: "anonymous" });
        return true;
      }
      if (req.method !== "GET" || url.pathname !== "/api/auth/login") return false;

      const returnTo = safeReturnPath(
        url.searchParams.get("returnTo") ?? "/",
        appOrigin,
      );
      if (!returnTo) {
        writeJson(res, 400, { error: "Login return path is invalid" });
        return true;
      }
      const guestBinding = readCookie(req.headers.cookie, "dano_guest");
      const existingFlowBinding = readCookie(
        req.headers.cookie,
        FLOW_COOKIE_NAME,
      );
      const browserBinding =
        guestBinding ?? existingFlowBinding ?? randomOpaqueId();
      const browserBindingHash = digest(browserBinding);
      const anonymousUser = guestBinding
        ? await lifecycle.resolveAnonymousUser(req.headers)
        : null;
      const pendingLogin = await withBrowserLock(
        browserLocks,
        browserBindingHash,
        async () => {
          const pending = await countPendingTransactions(
            transactionsPath,
            browserBindingHash,
            now(),
            stateTtlMs,
          );
          if (pending >= maxPendingTransactions) return null;
          const state = randomOpaqueId();
          const recordPath = transactionPath(transactionsPath, state);
          await fs.promises.writeFile(
            recordPath,
            `${JSON.stringify({
              version: 1,
              browserBindingHash,
              returnTo,
              ...(anonymousUser
                ? { anonymousUserId: anonymousUser.user.id }
                : {}),
              createdAt: now(),
            } satisfies StoredLoginTransaction)}\n`,
            { encoding: "utf8", flag: "wx", mode: 0o600 },
          );
          try {
            return {
              state,
              authorizationUrl: options.provider.authorizationUrl({
                state,
                redirectUri: redirectUri.href,
              }),
            };
          } catch (error) {
            await fs.promises.rm(recordPath, { force: true });
            throw error;
          }
        },
      );
      if (!pendingLogin) {
        writeJson(res, 429, { error: "Too many pending login attempts" });
        return true;
      }
      const { state, authorizationUrl } = pendingLogin;
      res.writeHead(303, {
        Location: authorizationUrl.href,
        ...(!guestBinding && !existingFlowBinding
          ? { "Set-Cookie": serializeCookie(FLOW_COOKIE_NAME, browserBinding) }
          : {}),
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
      return true;
    },
    async dispose(): Promise<void> {
      clearInterval(cleanupInterval);
    },
  };
}

interface StoredLoginTransaction {
  readonly version: 1;
  readonly browserBindingHash: string;
  readonly returnTo: string;
  readonly anonymousUserId?: string;
  readonly createdAt: number;
}

interface StoredEncryptedCredential {
  readonly algorithm: "aes-256-gcm";
  readonly keyVersion: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

interface StoredLoginSession {
  readonly version: 1;
  readonly user: AuthenticatedUser;
  readonly createdAt: number;
  readonly lastActiveAt: number;
  readonly absoluteExpiresAt: number;
  readonly credential: StoredEncryptedCredential;
}

async function handleCallback(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  options: {
    transactionsPath: string;
    sessionsPath: string;
    redirectUri: string;
    provider: OAuthProviderAdapter;
    encryptionKey: OAuthAuthenticationOptions["credentialEncryptionKey"];
    usersRootPath: string;
    now: () => number;
    stateTtlMs: number;
    lifecycle: AuthHttpLifecycle;
  },
): Promise<void> {
  const state = url.searchParams.get("state") ?? "";
  const browserBinding =
    readCookie(req.headers.cookie, "dano_guest") ??
    readCookie(req.headers.cookie, FLOW_COOKIE_NAME);
  const consumed =
    browserBinding && OPAQUE_ID_PATTERN.test(state)
      ? await consumeTransaction(
          options.transactionsPath,
          state,
          digest(browserBinding),
          options.now(),
          options.stateTtlMs,
        )
      : null;
  if (!consumed) {
    redirectAfterCallback(res, "/");
    return;
  }

  try {
    const code = url.searchParams.get("code");
    if (url.searchParams.has("error") || !code) {
      redirectAfterCallback(res, consumed.transaction.returnTo);
      return;
    }
    const result = await options.provider.exchangeAuthorizationCode({
      code,
      state,
      redirectUri: options.redirectUri,
    });
    const user = externalIdentityUser(result.identity);
    const credential = validCredential(result.credential);
    const sessionId = randomOpaqueId();
    const sessionKey = digest(sessionId);
    const createdAt = options.now();
    const session: StoredLoginSession = {
      version: 1,
      user,
      createdAt,
      lastActiveAt: createdAt,
      absoluteExpiresAt: createdAt + SESSION_ABSOLUTE_TTL_MS,
      credential: encryptCredential(
        credential,
        options.encryptionKey,
        sessionKey,
      ),
    };
    const sessionPath = loginSessionPath(options.sessionsPath, sessionId);
    await writeLoginSession(sessionPath, session);
    try {
      if (consumed.transaction.anonymousUserId) {
        await options.lifecycle.transferAnonymousUser(
          req.headers,
          consumed.transaction.anonymousUserId,
          {
            user,
            folderPath: await ensureUserFolder(options.usersRootPath, user.id),
          },
        );
      }
    } catch (error) {
      await fs.promises.rm(sessionPath, { force: true }).catch(() => {});
      await options.provider.revokeCredential?.(credential).catch(() => {});
      throw error;
    }
    redirectAfterCallback(res, consumed.transaction.returnTo, sessionId);
  } catch {
    redirectAfterCallback(res, consumed.transaction.returnTo);
  } finally {
    await fs.promises.rm(consumed.consumedPath, { force: true }).catch(() => {});
  }
}

async function consumeTransaction(
  transactionsPath: string,
  state: string,
  browserBindingHash: string,
  now: number,
  stateTtlMs: number,
): Promise<{
  transaction: StoredLoginTransaction;
  consumedPath: string;
} | null> {
  const sourcePath = transactionPath(transactionsPath, state);
  const consumedPath = `${sourcePath}.${randomUUID()}.consumed`;
  try {
    await fs.promises.rename(sourcePath, consumedPath);
    const transaction = parseLoginTransaction(
      await fs.promises.readFile(consumedPath, "utf8"),
    );
    if (
      transaction.browserBindingHash !== browserBindingHash ||
      now - transaction.createdAt >= stateTtlMs
    ) {
      await fs.promises.rm(consumedPath, { force: true });
      return null;
    }
    return { transaction, consumedPath };
  } catch {
    await fs.promises.rm(consumedPath, { force: true }).catch(() => {});
    return null;
  }
}

function externalIdentityUser(identity: ExternalIdentity): AuthenticatedUser {
  const username = identity.displayName?.trim() || "已登录用户";
  const avatarUrl = safeAvatarUrl(identity.avatarUrl);
  return {
    id: `oauth_${digest(identity.userId)}`,
    username,
    ...(avatarUrl ? { avatarUrl } : {}),
  };
}

function safeAvatarUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function validCredential(credential: ProviderCredential): ProviderCredential {
  if (!credential.accessToken?.trim()) {
    throw new Error("Provider credential is invalid");
  }
  return credential;
}

function encryptCredential(
  credential: ProviderCredential,
  key: OAuthAuthenticationOptions["credentialEncryptionKey"],
  sessionKey: string,
): StoredEncryptedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(Buffer.from(`dano-credential:v1:${key.version}:${sessionKey}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credential), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "aes-256-gcm",
    keyVersion: key.version,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decryptCredential(
  stored: StoredEncryptedCredential,
  key: OAuthAuthenticationOptions["credentialEncryptionKey"],
  sessionKey: string,
): ProviderCredential {
  if (stored.algorithm !== "aes-256-gcm" || stored.keyVersion !== key.version) {
    throw new Error("Provider credential key is unavailable");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key.key,
    Buffer.from(stored.iv, "base64url"),
  );
  decipher.setAAD(Buffer.from(`dano-credential:v1:${key.version}:${sessionKey}`));
  decipher.setAuthTag(Buffer.from(stored.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(stored.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return validCredential(JSON.parse(plaintext) as ProviderCredential);
}

async function writeLoginSession(
  recordPath: string,
  session: StoredLoginSession,
): Promise<void> {
  await writeFileAtomically(recordPath, `${JSON.stringify(session)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    fsync: true,
  });
  await fs.promises.chmod(recordPath, 0o600);
}

function parseLoginTransaction(serialized: string): StoredLoginTransaction {
  const value = JSON.parse(serialized) as Partial<StoredLoginTransaction>;
  if (
    value.version !== 1 ||
    typeof value.browserBindingHash !== "string" ||
    typeof value.returnTo !== "string" ||
    (value.anonymousUserId !== undefined &&
      typeof value.anonymousUserId !== "string") ||
    typeof value.createdAt !== "number"
  ) {
    throw new Error("OAuth login transaction is invalid");
  }
  return value as StoredLoginTransaction;
}

function parseLoginSession(serialized: string): StoredLoginSession {
  const value = JSON.parse(serialized) as Partial<StoredLoginSession>;
  if (
    value.version !== 1 ||
    !value.user ||
    typeof value.user.id !== "string" ||
    typeof value.user.username !== "string" ||
    typeof value.createdAt !== "number" ||
    typeof value.lastActiveAt !== "number" ||
    typeof value.absoluteExpiresAt !== "number" ||
    !value.credential
  ) {
    throw new Error("OAuth Login Session is invalid");
  }
  return value as StoredLoginSession;
}

async function countPendingTransactions(
  transactionsPath: string,
  browserBindingHash: string,
  now: number,
  stateTtlMs: number,
): Promise<number> {
  let count = 0;
  for (const name of await fs.promises.readdir(transactionsPath)) {
    if (!name.endsWith(".json")) continue;
    const recordPath = path.join(transactionsPath, name);
    try {
      const transaction = parseLoginTransaction(
        await fs.promises.readFile(recordPath, "utf8"),
      );
      if (now - transaction.createdAt >= stateTtlMs) {
        await fs.promises.rm(recordPath, { force: true });
      } else if (transaction.browserBindingHash === browserBindingHash) {
        count += 1;
      }
    } catch {
      await fs.promises.rm(recordPath, { force: true }).catch(() => {});
    }
  }
  return count;
}

async function withBrowserLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void;
  const current = new Promise<void>(resolve => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release!();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

async function cleanupExpiredRecords(
  transactionsPath: string,
  sessionsPath: string,
  now: number,
  stateTtlMs: number,
): Promise<void> {
  await countPendingTransactions(transactionsPath, "", now, stateTtlMs);
  for (const name of await fs.promises.readdir(sessionsPath)) {
    if (!name.endsWith(".json")) continue;
    const recordPath = path.join(sessionsPath, name);
    try {
      const session = parseLoginSession(
        await fs.promises.readFile(recordPath, "utf8"),
      );
      if (
        now - session.lastActiveAt >= SESSION_IDLE_TTL_MS ||
        now >= session.absoluteExpiresAt
      ) {
        await fs.promises.rm(recordPath, { force: true });
      }
    } catch {
      await fs.promises.rm(recordPath, { force: true }).catch(() => {});
    }
  }
}

function randomOpaqueId(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function transactionPath(rootPath: string, state: string): string {
  return path.join(rootPath, `${digest(state)}.json`);
}

function loginSessionPath(rootPath: string, sessionId: string): string {
  return path.join(rootPath, `${digest(sessionId)}.json`);
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    try {
      const value = decodeURIComponent(pair.slice(separator + 1).trim());
      return OPAQUE_ID_PATTERN.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

function serializeCookie(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function serializeLoginCookie(sessionId: string): string {
  return `${serializeCookie(LOGIN_COOKIE_NAME, sessionId)}; Max-Age=${Math.floor(
    SESSION_ABSOLUTE_TTL_MS / 1000,
  )}`;
}

function serializeExpiredLoginCookie(): string {
  return `${serializeCookie(LOGIN_COOKIE_NAME, "")}; Max-Age=0`;
}

function sameOrigin(value: string | undefined, appOrigin: string): boolean {
  if (!value) return false;
  try {
    return new URL(value).origin === appOrigin;
  } catch {
    return false;
  }
}

function redirectAfterCallback(
  res: http.ServerResponse,
  returnTo: string,
  sessionId?: string,
): void {
  res.writeHead(303, {
    Location: returnTo,
    ...(sessionId ? { "Set-Cookie": serializeLoginCookie(sessionId) } : {}),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end();
}

function safeReturnPath(value: string, appOrigin: string): string | null {
  try {
    const target = new URL(value, appOrigin);
    if (
      target.origin !== appOrigin ||
      !value.startsWith("/") ||
      value.startsWith("//")
    ) {
      return null;
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

function writeJson(
  res: http.ServerResponse,
  status: number,
  value: unknown,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(JSON.stringify(value));
}
