import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_CONFIG,
  type ClientMessage,
  type ServerMessage,
} from "../bridge/types.js";
import { createAnonymousUserContextResolver } from "../bridge/anonymous-user-context.js";
import {
  createJwtUserContextResolver,
  type AuthenticatedUserContextResolver,
  UserContextError,
} from "../bridge/user-context.js";
import { startDanoServer, type DanoServerController } from "../server.js";

const controllers: DanoServerController[] = [];
const runtimeRoots: string[] = [];

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.stop()));
  for (const root of runtimeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function startAnonymousServer(
  runtimeRootPath: string,
  secureCookie = false,
  authenticatedResolver?: AuthenticatedUserContextResolver,
  sessionsRootPath?: string,
  cleanup?: { idleTtlMs: number; intervalMs: number; now: () => number },
) {
  const anonymousUsers = createAnonymousUserContextResolver({
    runtimeRootPath,
    secureCookie,
    authenticatedResolver,
    now: cleanup?.now,
    activityWriteIntervalMs: cleanup
      ? Math.max(1, Math.floor(cleanup.idleTtlMs / 2))
      : undefined,
  });
  const controller = await startDanoServer(
    {
      ...DEFAULT_BRIDGE_CONFIG,
      host: "127.0.0.1",
      port: 0,
      upload: {
        ...DEFAULT_BRIDGE_CONFIG.upload,
        uploadDir: path.join(runtimeRootPath, "uploads"),
      },
    },
    {
      captureSigint: false,
      sessionsRootPath,
      userContextResolver: anonymousUsers,
      ...(cleanup
        ? { anonymousUsers, anonymousUserCleanup: cleanup }
        : {}),
    },
  );
  controllers.push(controller);
  const origin = controller.getBridgeUrl();
  if (!origin) throw new Error("Dano test server did not start");
  return { controller, origin };
}

function signUser(userId: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: userId,
    name: "Authenticated User",
    exp: Math.floor(Date.now() / 1000) + 60,
  })}`;
  return `${unsigned}.${createHmac("sha256", "test-auth-secret")
    .update(unsigned)
    .digest("base64url")}`;
}

function guestCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Expected guest Cookie");
  return setCookie.split(";", 1)[0]!;
}

async function createClient(origin: string, cookie?: string) {
  const response = await fetch(`${origin}/api/clients`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: "{}",
  });
  expect(response.status).toBe(201);
  return {
    response,
    body: (await response.json()) as {
      client: { id: string };
      authentication: { status: string };
      defaultWorkspacePath: string;
      eventsUrl: string;
      messagesUrl: string;
    },
  };
}

function waitForResponse(
  url: string,
  cookie: string,
  correlationId: string,
): { close(): void; ready: Promise<void>; result: Promise<ServerMessage> } {
  let request: http.ClientRequest;
  let markReady: () => void;
  const ready = new Promise<void>(resolve => {
    markReady = resolve;
  });
  const result = new Promise<ServerMessage>((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error(`Timed out waiting for ${correlationId}`));
    }, 2_000);
    request = http.get(url, { headers: { Cookie: cookie } }, response => {
      markReady();
      response.setEncoding("utf8");
      response.on("data", chunk => {
        buffer += chunk;
        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split(/\r?\n/)
            .filter(line => line.startsWith("data: "))
            .map(line => line.slice(6))
            .join("\n");
          if (data) {
            const message = JSON.parse(data) as ServerMessage;
            if (
              message.type === "response" &&
              message.payload.id === correlationId
            ) {
              clearTimeout(timeout);
              resolve(message);
              return;
            }
          }
          boundary = buffer.indexOf("\n\n");
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
  });
  return { ready, result, close: () => request.destroy() };
}

async function openEventStream(
  url: string,
  cookie: string,
): Promise<http.ClientRequest> {
  const request = http.get(url, { headers: { Cookie: cookie } });
  await new Promise<void>((resolve, reject) => {
    request.once("response", () => resolve());
    request.once("error", reject);
  });
  return request;
}

async function executeCommand(
  origin: string,
  client: Awaited<ReturnType<typeof createClient>>["body"],
  cookie: string,
  payload: Extract<ClientMessage, { type: "command" }>["payload"],
): Promise<ServerMessage> {
  const correlationId = payload.id;
  if (!correlationId) throw new Error("Test commands require an id");
  const response = waitForResponse(
    `${origin}${client.eventsUrl}`,
    cookie,
    correlationId,
  );
  try {
    await response.ready;
    const posted = await fetch(`${origin}${client.messagesUrl}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "command", payload } satisfies ClientMessage),
    });
    expect(posted.status).toBe(202);
    return await response.result;
  } finally {
    response.close();
  }
}

async function uploadProjectFile(
  origin: string,
  clientId: string,
  cookie: string,
  name: string,
  content: string,
) {
  const body = new TextEncoder().encode(content);
  const sha256 = createHash("sha256").update(body).digest("hex");
  const response = await fetch(
    `${origin}/api/uploads?clientId=${encodeURIComponent(clientId)}&name=${encodeURIComponent(name)}&mimeType=text/plain&sha256=${sha256}`,
    { method: "POST", headers: { Cookie: cookie }, body },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as {
    id: string;
    name: string;
    size: number;
    mimeType: string;
    previewUrl: string;
    path: string;
    relativePath: string;
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for cleanup");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe("Anonymous User over HTTP/Bridge", () => {
  it("reclaims an idle Client that never establishes its SSE stream", async () => {
    let now = 500;
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-no-sse-"),
    );
    runtimeRoots.push(runtimeRoot);
    const anonymousSessionsPath = path.join(runtimeRoot, "anonymous-sessions");
    const sessionsRootPath = path.join(runtimeRoot, "sessions");
    const { origin } = await startAnonymousServer(
      runtimeRoot,
      false,
      undefined,
      sessionsRootPath,
      { idleTtlMs: 1_000, intervalMs: 10, now: () => now },
    );
    const guest = await createClient(origin);
    const cookie = guestCookie(guest.response);
    const ownedFile = path.join(guest.body.defaultWorkspacePath, "abandoned.txt");
    fs.writeFileSync(ownedFile, "client never opened SSE", "utf8");
    const upload = await uploadProjectFile(
      origin,
      guest.body.client.id,
      cookie,
      "abandoned-upload.txt",
      "temporary upload",
    );

    now = 1_501;

    await waitUntil(() => fs.readdirSync(anonymousSessionsPath).length === 0);
    expect(fs.existsSync(guest.body.defaultWorkspacePath)).toBe(false);
    expect(fs.existsSync(ownedFile)).toBe(false);
    expect(fs.existsSync(upload.path)).toBe(false);
    expect(fs.readdirSync(path.join(runtimeRoot, "uploads", "records"))).toEqual(
      [],
    );
    expect(fs.readdirSync(sessionsRootPath)).toEqual([]);
    const replacement = await createClient(origin, cookie);
    expect(guestCookie(replacement.response)).not.toBe(cookie);
  });

  it("reclaims a lost SSE Client after its replacement disconnects", async () => {
    let now = 1_000;
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-lost-sse-"),
    );
    runtimeRoots.push(runtimeRoot);
    const anonymousSessionsPath = path.join(runtimeRoot, "anonymous-sessions");
    const { origin } = await startAnonymousServer(
      runtimeRoot,
      false,
      undefined,
      undefined,
      { idleTtlMs: 1_000, intervalMs: 10, now: () => now },
    );
    const first = await createClient(origin);
    const cookie = guestCookie(first.response);
    const ownedFile = path.join(first.body.defaultWorkspacePath, "owned.txt");
    fs.writeFileSync(ownedFile, "owned by lost SSE client", "utf8");
    const lostStream = await openEventStream(
      `${origin}${first.body.eventsUrl}`,
      cookie,
    );
    lostStream.destroy();
    await new Promise(resolve => setTimeout(resolve, 10));

    const replacement = await createClient(origin, cookie);
    const replacementStream = await openEventStream(
      `${origin}${replacement.body.eventsUrl}`,
      cookie,
    );
    const disconnected = await fetch(
      `${origin}/api/clients/${replacement.body.client.id}/disconnect`,
      { method: "POST", headers: { Cookie: cookie }, body: "{}" },
    );
    expect(disconnected.status).toBe(202);
    replacementStream.destroy();

    now = 2_001;
    await waitUntil(() => fs.readdirSync(anonymousSessionsPath).length === 0);
    expect(fs.existsSync(first.body.defaultWorkspacePath)).toBe(false);
    expect(fs.existsSync(ownedFile)).toBe(false);
  });

  it("keeps a transiently disconnected SSE Client usable after reconnect", async () => {
    let now = 10_000;
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-sse-reconnect-"),
    );
    runtimeRoots.push(runtimeRoot);
    const { origin } = await startAnonymousServer(
      runtimeRoot,
      false,
      undefined,
      undefined,
      { idleTtlMs: 1_000, intervalMs: 10, now: () => now },
    );
    const guest = await createClient(origin);
    const cookie = guestCookie(guest.response);
    const firstStream = await openEventStream(
      `${origin}${guest.body.eventsUrl}`,
      cookie,
    );
    firstStream.destroy();

    now = 10_900;
    const reconnectedStream = await openEventStream(
      `${origin}${guest.body.eventsUrl}`,
      cookie,
    );
    const accepted = await fetch(`${origin}${guest.body.messagesUrl}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "command",
        payload: { id: "reconnected-state", type: "get_state" },
      } satisfies ClientMessage),
    });
    expect(accepted.status).toBe(202);

    now = 11_901;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fs.existsSync(guest.body.defaultWorkspacePath)).toBe(true);
    const stillAccepted = await fetch(`${origin}${guest.body.messagesUrl}`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "command",
        payload: { id: "post-sweep-state", type: "get_state" },
      } satisfies ClientMessage),
    });
    expect(stillAccepted.status).toBe(202);
    reconnectedStream.destroy();
  });

  it("keeps an active SSE guest and later removes all data after the stream closes", async () => {
    let now = 1_000;
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-expiry-"),
    );
    runtimeRoots.push(runtimeRoot);
    const anonymousSessionsPath = path.join(
      runtimeRoot,
      "anonymous-sessions",
    );
    const sessionsRootPath = path.join(runtimeRoot, "sessions");
    const { origin } = await startAnonymousServer(
      runtimeRoot,
      false,
      undefined,
      sessionsRootPath,
      { idleTtlMs: 1_000, intervalMs: 10, now: () => now },
    );
    const guest = await createClient(origin);
    const cookie = guestCookie(guest.response);
    const stream = await openEventStream(
      `${origin}${guest.body.eventsUrl}`,
      cookie,
    );
    const ownedFile = path.join(guest.body.defaultWorkspacePath, "owned.txt");
    fs.writeFileSync(ownedFile, "owned by expiring guest", "utf8");
    const upload = await uploadProjectFile(
      origin,
      guest.body.client.id,
      cookie,
      "expiring-upload.txt",
      "temporary upload",
    );
    const preference = await fetch(
      `${origin}/api/clients/${guest.body.client.id}/preferences/theme`,
      {
        method: "PUT",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ accentColorPreset: "blue" }),
      },
    );
    expect(preference.status).toBe(200);

    now = 2_001;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fs.existsSync(ownedFile)).toBe(true);
    expect(fs.existsSync(upload.path)).toBe(true);

    stream.destroy();
    await new Promise(resolve => setTimeout(resolve, 10));
    now = 3_002;
    await waitUntil(
      () => fs.readdirSync(anonymousSessionsPath).length === 0,
    );

    expect(fs.existsSync(guest.body.defaultWorkspacePath)).toBe(false);
    expect(fs.existsSync(upload.path)).toBe(false);
    expect(fs.readdirSync(anonymousSessionsPath)).toEqual([]);
    expect(fs.readdirSync(path.join(runtimeRoot, "uploads", "records"))).toEqual(
      [],
    );
    expect(fs.readdirSync(sessionsRootPath)).toEqual([]);
    const stale = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(stale.status).toBe(201);
    expect(guestCookie(stale)).not.toBe(cookie);
  });

  it("never includes authenticated User data in an Anonymous User sweep", async () => {
    let now = 4_000;
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-auth-cleanup-"),
    );
    runtimeRoots.push(runtimeRoot);
    const authenticatedResolver = createJwtUserContextResolver({
      runtimeRootPath: runtimeRoot,
      secret: "test-auth-secret",
      now: () => Date.now(),
    });
    const { origin } = await startAnonymousServer(
      runtimeRoot,
      false,
      authenticatedResolver,
      undefined,
      { idleTtlMs: 1_000, intervalMs: 10, now: () => now },
    );
    const authenticated = await createClient(
      origin,
      `dano_auth=${signUser("retained-authenticated-user")}`,
    );
    const authenticatedFile = path.join(
      authenticated.body.defaultWorkspacePath,
      "authenticated.txt",
    );
    fs.writeFileSync(authenticatedFile, "must remain", "utf8");
    await fetch(
      `${origin}/api/clients/${authenticated.body.client.id}/disconnect`,
      {
        method: "POST",
        headers: { Cookie: `dano_auth=${signUser("retained-authenticated-user")}` },
        body: "{}",
      },
    );
    const guest = await createClient(origin);
    const guestCookieValue = guestCookie(guest.response);
    await fetch(`${origin}/api/clients/${guest.body.client.id}/disconnect`, {
      method: "POST",
      headers: { Cookie: guestCookieValue },
      body: "{}",
    });

    now = 5_001;
    await waitUntil(() => !fs.existsSync(guest.body.defaultWorkspacePath));
    expect(fs.readFileSync(authenticatedFile, "utf8")).toBe("must remain");
  });

  it("creates a usable Anonymous User and issues an opaque guest Cookie", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-http-"),
    );
    runtimeRoots.push(runtimeRoot);
    const { origin } = await startAnonymousServer(runtimeRoot);

    const response = await fetch(`${origin}/api/clients?userId=browser-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "anonymous-user-test",
      },
      body: JSON.stringify({
        clientId: "browser-client",
        userId: "browser-user",
      }),
    });
    const body = (await response.json()) as {
      client: { id: string };
      authentication: { status: string };
      defaultWorkspacePath: string;
      currentUser?: unknown;
    };
    const setCookie = response.headers.get("set-cookie");

    expect(response.status).toBe(201);
    expect(body.authentication).toEqual({ status: "anonymous" });
    expect(body).not.toHaveProperty("currentUser");
    expect(setCookie).toMatch(
      /^dano_guest=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax$/,
    );
    expect(setCookie).not.toContain(body.client.id);
    expect(setCookie).not.toContain("browser-client");
    expect(setCookie).not.toContain("browser-user");
    expect(body.defaultWorkspacePath).toContain(`${path.sep}users${path.sep}`);
  });

  it("restores the same Anonymous User across refresh and server restart", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-restart-"),
    );
    runtimeRoots.push(runtimeRoot);
    const firstServer = await startAnonymousServer(runtimeRoot);
    const first = await createClient(firstServer.origin);
    const cookie = guestCookie(first.response);
    const sessionState = await executeCommand(
      firstServer.origin,
      first.body,
      cookie,
      {
        id: "guest-restart-state",
        type: "new_session",
        workspacePath: first.body.defaultWorkspacePath,
      },
    );
    const sessionData = (
      sessionState.payload as {
        data?: { sessionPath?: string; sessionId?: string };
      }
    ).data;
    const sessionPath = sessionData?.sessionPath;
    expect(sessionPath).toBeTruthy();
    const uploaded = await uploadProjectFile(
      firstServer.origin,
      first.body.client.id,
      cookie,
      "restart.txt",
      "anonymous file survives restart",
    );
    const referenced = await executeCommand(
      firstServer.origin,
      first.body,
      cookie,
      {
        id: "guest-restart-upload",
        type: "steer",
        message: "Keep this file",
        files: [uploaded],
      },
    );
    expect(referenced.payload).toMatchObject({
      command: "steer",
      success: true,
    });
    fs.writeFileSync(
      sessionPath!,
      `${JSON.stringify({
        type: "session",
        id: sessionData?.sessionId,
        timestamp: "2026-08-11T00:00:00.000Z",
        cwd: first.body.defaultWorkspacePath,
      })}\n`,
      "utf8",
    );

    const refreshed = await createClient(firstServer.origin, cookie);
    expect(refreshed.response.headers.get("set-cookie")).toBeNull();
    expect(refreshed.body.defaultWorkspacePath).toBe(
      first.body.defaultWorkspacePath,
    );

    await firstServer.controller.stop();
    controllers.splice(controllers.indexOf(firstServer.controller), 1);
    const restartedServer = await startAnonymousServer(runtimeRoot);
    const restarted = await createClient(restartedServer.origin, cookie);

    expect(restarted.response.headers.get("set-cookie")).toBeNull();
    expect(restarted.body.defaultWorkspacePath).toBe(
      first.body.defaultWorkspacePath,
    );
    expect(restarted.body.authentication).toEqual({ status: "anonymous" });
    const switched = await executeCommand(
      restartedServer.origin,
      restarted.body,
      cookie,
      {
        id: "guest-restart-switch",
        type: "switch_session",
        sessionPath: sessionPath!,
      },
    );
    expect(switched.payload).toMatchObject({
      command: "switch_session",
      success: true,
    });
    const preview = await fetch(
      `${restartedServer.origin}${uploaded.previewUrl}`,
      { headers: { Cookie: cookie } },
    );
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe("anonymous file survives restart");
  });

  it("replaces an unknown or expired guest Cookie with a new Anonymous User", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-invalid-"),
    );
    runtimeRoots.push(runtimeRoot);
    const { origin } = await startAnonymousServer(runtimeRoot);
    const first = await createClient(origin);
    const originalCookie = guestCookie(first.response);
    const unknownCookie = `dano_guest=${"a".repeat(43)}`;

    const replacement = await createClient(origin, unknownCookie);
    const replacementCookie = guestCookie(replacement.response);
    expect(replacementCookie).not.toBe(unknownCookie);
    expect(replacement.body.defaultWorkspacePath).not.toBe(
      first.body.defaultWorkspacePath,
    );

    fs.rmSync(path.join(runtimeRoot, "anonymous-sessions"), {
      recursive: true,
      force: true,
    });
    const expired = await createClient(origin, originalCookie);
    expect(guestCookie(expired.response)).not.toBe(originalCookie);
    expect(expired.body.defaultWorkspacePath).not.toBe(
      first.body.defaultWorkspacePath,
    );
  });

  it("falls back to a new Anonymous User when an old authentication Cookie is invalid", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-invalid-auth-"),
    );
    runtimeRoots.push(runtimeRoot);
    const authenticatedResolver = createJwtUserContextResolver({
      runtimeRootPath: runtimeRoot,
      secret: "different-auth-secret",
    });
    const { origin } = await startAnonymousServer(
      runtimeRoot,
      false,
      authenticatedResolver,
    );
    const staleAuthenticationCookie = `dano_auth=${signUser("stale-user")}`;

    const created = await createClient(origin, staleAuthenticationCookie);
    const anonymousCookie = guestCookie(created.response);

    expect(created.body.authentication).toEqual({ status: "anonymous" });
    const restored = await createClient(
      origin,
      `${staleAuthenticationCookie}; ${anonymousCookie}`,
    );
    expect(restored.body.authentication).toEqual({ status: "anonymous" });
    expect(restored.body.defaultWorkspacePath).toBe(
      created.body.defaultWorkspacePath,
    );
  });

  it("does not hide an authentication resolver service failure", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-auth-failure-"),
    );
    runtimeRoots.push(runtimeRoot);
    const authenticatedResolver: AuthenticatedUserContextResolver = {
      async resolve() {
        throw new UserContextError(503, "Authentication service unavailable");
      },
    };
    const { origin } = await startAnonymousServer(
      runtimeRoot,
      false,
      authenticatedResolver,
    );

    const response = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("uses production guest Cookie attributes without a Domain attribute", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-secure-"),
    );
    runtimeRoots.push(runtimeRoot);
    const { origin } = await startAnonymousServer(runtimeRoot, true);

    const created = await createClient(origin);
    expect(created.response.headers.get("set-cookie")).toMatch(
      /^dano_guest=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
    expect(created.response.headers.get("set-cookie")).not.toMatch(/Domain=/i);
  });

  it("isolates Agent Sessions, preferences, and uploads between guest Cookies", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-isolation-"),
    );
    runtimeRoots.push(runtimeRoot);
    const { origin } = await startAnonymousServer(runtimeRoot);
    const first = await createClient(origin);
    const second = await createClient(origin);
    const firstCookie = guestCookie(first.response);
    const secondCookie = guestCookie(second.response);
    expect(firstCookie).not.toBe(secondCookie);
    expect(first.body.defaultWorkspacePath).not.toBe(
      second.body.defaultWorkspacePath,
    );

    const chat = await executeCommand(
      origin,
      first.body,
      firstCookie,
      {
        id: "guest-one-chat",
        type: "prompt",
        message: "Hello from an Anonymous User",
      },
    );
    expect(chat.payload).toMatchObject({ command: "prompt" });

    const firstState = await executeCommand(
      origin,
      first.body,
      firstCookie,
      { id: "guest-one-state", type: "get_state" },
    );
    const firstSessionPath = (
      firstState.payload as { data?: { sessionFile?: string } }
    ).data?.sessionFile;
    expect(firstSessionPath).toBeTruthy();
    const crossGuestSwitch = await executeCommand(
      origin,
      second.body,
      secondCookie,
      {
        id: "guest-two-switch",
        type: "switch_session",
        sessionPath: firstSessionPath!,
      },
    );
    expect(crossGuestSwitch.payload).toMatchObject({
      command: "switch_session",
      success: false,
    });

    const firstPreferenceUrl = `${origin}/api/clients/${first.body.client.id}/preferences/theme`;
    const secondPreferenceUrl = `${origin}/api/clients/${second.body.client.id}/preferences/theme`;
    expect(
      (
        await fetch(firstPreferenceUrl, {
          method: "PUT",
          headers: {
            Cookie: firstCookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ accentColorPreset: "blue" }),
        })
      ).status,
    ).toBe(200);
    await expect(
      (await fetch(secondPreferenceUrl, { headers: { Cookie: secondCookie } })).json(),
    ).resolves.toEqual({ accentColorPreset: "default" });

    const uploaded = await uploadProjectFile(
      origin,
      first.body.client.id,
      firstCookie,
      "private.txt",
      "guest one only",
    );
    const forgedPreview = new URL(uploaded.previewUrl, origin);
    forgedPreview.searchParams.set("clientId", second.body.client.id);
    expect(
      (
        await fetch(forgedPreview, {
          headers: { Cookie: secondCookie },
        })
      ).status,
    ).toBe(403);
    expect(fs.existsSync(uploaded.path)).toBe(true);
  });

  it("keeps an Anonymous User isolated from an authenticated User", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-authenticated-"),
    );
    runtimeRoots.push(runtimeRoot);
    const { origin } = await startAnonymousServer(
      runtimeRoot,
      false,
      createJwtUserContextResolver({
        runtimeRootPath: runtimeRoot,
        secret: "test-auth-secret",
      }),
    );
    const guest = await createClient(origin);
    const guestId = guestCookie(guest.response);
    const authenticatedResponse = await fetch(`${origin}/api/clients`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${signUser("authenticated-user")}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const authenticated = (await authenticatedResponse.json()) as {
      client: { id: string };
      authentication: { status: string };
      defaultWorkspacePath: string;
    };

    expect(authenticatedResponse.status).toBe(201);
    expect(authenticatedResponse.headers.get("set-cookie")).toBeNull();
    expect(authenticated.authentication.status).toBe("authenticated");
    expect(authenticated.defaultWorkspacePath).not.toBe(
      guest.body.defaultWorkspacePath,
    );
    const guestState = await executeCommand(origin, guest.body, guestId, {
      id: "guest-auth-boundary",
      type: "get_state",
    });
    const guestSessionPath = (
      guestState.payload as { data?: { sessionFile?: string } }
    ).data?.sessionFile;
    const forged = await fetch(
      `${origin}/api/clients/${authenticated.client.id}/messages`,
      {
        method: "POST",
        headers: { Cookie: guestId, "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "command",
          payload: {
            id: "guest-to-authenticated",
            type: "switch_session",
            sessionPath: guestSessionPath!,
          },
        } satisfies ClientMessage),
      },
    );
    expect(forged.status).toBe(403);
  });

  it("uses the configured sessions root as isolated per-User session roots", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-anonymous-session-base-"),
    );
    runtimeRoots.push(runtimeRoot);
    const sessionsRoot = path.join(runtimeRoot, "configured-sessions");
    const { origin } = await startAnonymousServer(
      runtimeRoot,
      false,
      undefined,
      sessionsRoot,
    );
    const first = await createClient(origin);
    const second = await createClient(origin);
    const firstState = await executeCommand(
      origin,
      first.body,
      guestCookie(first.response),
      { id: "configured-session-one", type: "get_state" },
    );
    const secondState = await executeCommand(
      origin,
      second.body,
      guestCookie(second.response),
      { id: "configured-session-two", type: "get_state" },
    );
    const firstSession = (
      firstState.payload as { data?: { sessionFile?: string } }
    ).data?.sessionFile;
    const secondSession = (
      secondState.payload as { data?: { sessionFile?: string } }
    ).data?.sessionFile;

    expect(firstSession).toBeTruthy();
    expect(secondSession).toBeTruthy();
    expect(path.relative(sessionsRoot, firstSession!).startsWith("..")).toBe(
      false,
    );
    expect(path.relative(sessionsRoot, secondSession!).startsWith("..")).toBe(
      false,
    );
    expect(firstSession).not.toBe(secondSession);
    expect(path.relative(sessionsRoot, firstSession!).split(path.sep)[0]).not.toBe(
      path.relative(sessionsRoot, secondSession!).split(path.sep)[0],
    );
  });
});
