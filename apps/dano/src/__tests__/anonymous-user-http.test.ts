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
) {
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
      userContextResolver: createAnonymousUserContextResolver({
        runtimeRootPath,
        secureCookie,
        authenticatedResolver,
      }),
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

describe("Anonymous User over HTTP/Bridge", () => {
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
