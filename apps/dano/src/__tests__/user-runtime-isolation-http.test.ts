import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
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
import { createJwtUserContextResolver } from "../bridge/user-context.js";
import { startDanoServer, type DanoServerController } from "../server.js";

const TEST_JWT_SECRET = "test-secret-that-is-long-enough";
const controllers: DanoServerController[] = [];
const runtimeRoots: string[] = [];

afterEach(async () => {
  await Promise.all(controllers.splice(0).map(controller => controller.stop()));
  for (const root of runtimeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function signUser(userId: string, username: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: userId,
    name: username,
    exp: Math.floor(Date.now() / 1000) + 60,
  })}`;
  const signature = createHmac("sha256", TEST_JWT_SECRET)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

async function createClient(origin: string, token: string) {
  const response = await fetch(`${origin}/api/clients`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    client: { id: string };
    defaultWorkspacePath: string;
    eventsUrl: string;
    messagesUrl: string;
  };
}

function waitForResponse(
  url: string,
  token: string,
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
    request = http.get(
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      response => {
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
      },
    );
    request.on("error", reject);
  });
  return { ready, result, close: () => request.destroy() };
}

async function executeCommand(
  origin: string,
  client: Awaited<ReturnType<typeof createClient>>,
  token: string,
  payload: Extract<ClientMessage, { type: "command" }>["payload"],
): Promise<ServerMessage> {
  const correlationId = payload.id;
  if (!correlationId) throw new Error("Test commands require an id");
  const response = waitForResponse(
    `${origin}${client.eventsUrl}`,
    token,
    correlationId,
  );
  try {
    await response.ready;
    const posted = await fetch(`${origin}${client.messagesUrl}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "command", payload } satisfies ClientMessage),
    });
    expect(posted.status).toBe(202);
    return await response.result;
  } finally {
    response.close();
  }
}

describe("User runtime isolation over HTTP/SSE", () => {
  it("assigns each authenticated User an isolated default Runtime Workspace", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-user-runtime-http-"),
    );
    runtimeRoots.push(runtimeRoot);
    fs.mkdirSync(path.join(runtimeRoot, "legacy-global-workspace"));
    const controller = await startDanoServer(
      {
        ...DEFAULT_BRIDGE_CONFIG,
        host: "127.0.0.1",
        port: 0,
        upload: {
          ...DEFAULT_BRIDGE_CONFIG.upload,
          uploadDir: path.join(runtimeRoot, "uploads"),
        },
      },
      {
        cwd: path.join(runtimeRoot, "legacy-global-workspace"),
        sessionDir: path.join(runtimeRoot, "legacy-global-sessions"),
        captureSigint: false,
        userContextResolver: createJwtUserContextResolver({
          runtimeRootPath: runtimeRoot,
          secret: TEST_JWT_SECRET,
        }),
      },
    );
    controllers.push(controller);
    const origin = controller.getBridgeUrl();
    if (!origin) throw new Error("Dano test server did not start");

    const alice = await createClient(origin, signUser("alice", "Alice"));
    const bob = await createClient(origin, signUser("bob", "Bob"));
    const realRuntimeRoot = fs.realpathSync(runtimeRoot);

    expect(alice.defaultWorkspacePath).toBe(
      path.join(realRuntimeRoot, "users", "alice", "workspaces", "default"),
    );
    expect(bob.defaultWorkspacePath).toBe(
      path.join(realRuntimeRoot, "users", "bob", "workspaces", "default"),
    );
    expect(alice.defaultWorkspacePath).not.toBe(bob.defaultWorkspacePath);
  });

  it("shares Agent Sessions with the same User and rejects another User's Session path", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-user-session-http-"),
    );
    runtimeRoots.push(runtimeRoot);
    const controller = await startDanoServer(
      {
        ...DEFAULT_BRIDGE_CONFIG,
        host: "127.0.0.1",
        port: 0,
        upload: {
          ...DEFAULT_BRIDGE_CONFIG.upload,
          uploadDir: path.join(runtimeRoot, "uploads"),
        },
      },
      {
        captureSigint: false,
        userContextResolver: createJwtUserContextResolver({
          runtimeRootPath: runtimeRoot,
          secret: TEST_JWT_SECRET,
        }),
      },
    );
    controllers.push(controller);
    const origin = controller.getBridgeUrl();
    if (!origin) throw new Error("Dano test server did not start");
    const aliceToken = signUser("alice-sessions", "Alice");
    const bobToken = signUser("bob-sessions", "Bob");
    const aliceFirst = await createClient(origin, aliceToken);
    const aliceSecond = await createClient(origin, aliceToken);
    const bob = await createClient(origin, bobToken);

    const named = await executeCommand(origin, aliceFirst, aliceToken, {
      id: "alice-name",
      type: "set_session_name",
      name: "Alice private session",
    });
    expect(named.payload).toMatchObject({
      command: "set_session_name",
      success: true,
    });
    const aliceState = await executeCommand(
      origin,
      aliceFirst,
      aliceToken,
      { id: "alice-state", type: "get_state" },
    );
    const aliceSessionPath = (
      aliceState.payload as { data?: { sessionFile?: string } }
    ).data?.sessionFile;
    expect(aliceSessionPath).toBeTruthy();
    fs.writeFileSync(
      aliceSessionPath!,
      `${JSON.stringify({
        type: "session",
        id: "alice-private-session",
        timestamp: "2026-08-11T00:00:00.000Z",
        cwd: aliceFirst.defaultWorkspacePath,
      })}\n`,
      "utf8",
    );
    expect(fs.existsSync(aliceSessionPath!)).toBe(true);

    const shared = await executeCommand(origin, aliceSecond, aliceToken, {
      id: "alice-switch",
      type: "switch_session",
      sessionPath: aliceSessionPath!,
    });
    expect(shared.payload).toMatchObject({
      command: "switch_session",
      success: true,
      data: { sessionPath: aliceSessionPath },
    });

    const rejected = await executeCommand(origin, bob, bobToken, {
      id: "bob-switch",
      type: "switch_session",
      sessionPath: aliceSessionPath!,
    });
    expect(rejected.payload).toMatchObject({
      command: "switch_session",
      success: false,
    });

    const deleteRejected = await executeCommand(origin, bob, bobToken, {
      id: "bob-delete",
      type: "delete_session",
      sessionPath: aliceSessionPath!,
    });
    expect(deleteRejected.payload).toMatchObject({
      command: "delete_session",
      success: false,
    });
    expect(fs.existsSync(aliceSessionPath!)).toBe(true);
  });

  it("restores only the owning User's Agent Sessions after restart", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-user-restart-http-"),
    );
    runtimeRoots.push(runtimeRoot);
    const config = {
      ...DEFAULT_BRIDGE_CONFIG,
      host: "127.0.0.1",
      port: 0,
      upload: {
        ...DEFAULT_BRIDGE_CONFIG.upload,
        uploadDir: path.join(runtimeRoot, "uploads"),
      },
    };
    const resolver = createJwtUserContextResolver({
      runtimeRootPath: runtimeRoot,
      secret: TEST_JWT_SECRET,
    });
    const aliceToken = signUser("alice-restart", "Alice");
    const bobToken = signUser("bob-restart", "Bob");
    const firstController = await startDanoServer(config, {
      captureSigint: false,
      userContextResolver: resolver,
    });
    controllers.push(firstController);
    const firstOrigin = firstController.getBridgeUrl();
    if (!firstOrigin) throw new Error("Dano test server did not start");
    const firstAlice = await createClient(firstOrigin, aliceToken);
    const firstState = await executeCommand(
      firstOrigin,
      firstAlice,
      aliceToken,
      { id: "restart-state", type: "get_state" },
    );
    const storedSessionPath = (
      firstState.payload as { data?: { sessionFile?: string } }
    ).data?.sessionFile;
    expect(storedSessionPath).toBeTruthy();
    fs.writeFileSync(
      storedSessionPath!,
      `${JSON.stringify({
        type: "session",
        id: "alice-restart-session",
        timestamp: "2026-08-11T00:00:00.000Z",
        cwd: firstAlice.defaultWorkspacePath,
      })}\n`,
      "utf8",
    );
    await firstController.stop();
    controllers.splice(controllers.indexOf(firstController), 1);

    const secondController = await startDanoServer(config, {
      captureSigint: false,
      userContextResolver: resolver,
    });
    controllers.push(secondController);
    const secondOrigin = secondController.getBridgeUrl();
    if (!secondOrigin) throw new Error("Dano test server did not restart");
    const secondAlice = await createClient(secondOrigin, aliceToken);
    const bob = await createClient(secondOrigin, bobToken);
    const restored = await executeCommand(
      secondOrigin,
      secondAlice,
      aliceToken,
      {
        id: "alice-restored-list",
        type: "list_sessions",
        workspacePath: secondAlice.defaultWorkspacePath,
      },
    );
    expect(
      (
        restored.payload as {
          data?: { sessions?: Array<{ path: string }> };
        }
      ).data?.sessions,
    ).toContainEqual(expect.objectContaining({ path: storedSessionPath }));

    const rejected = await executeCommand(secondOrigin, bob, bobToken, {
      id: "bob-forged-list",
      type: "list_sessions",
      workspacePath: secondAlice.defaultWorkspacePath,
    });
    expect(rejected.payload).toMatchObject({
      command: "list_sessions",
      success: false,
    });
  });

  it("rejects another User's Runtime Workspace path", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-user-workspace-http-"),
    );
    runtimeRoots.push(runtimeRoot);
    const controller = await startDanoServer(
      {
        ...DEFAULT_BRIDGE_CONFIG,
        host: "127.0.0.1",
        port: 0,
        upload: {
          ...DEFAULT_BRIDGE_CONFIG.upload,
          uploadDir: path.join(runtimeRoot, "uploads"),
        },
      },
      {
        captureSigint: false,
        userContextResolver: createJwtUserContextResolver({
          runtimeRootPath: runtimeRoot,
          secret: TEST_JWT_SECRET,
        }),
      },
    );
    controllers.push(controller);
    const origin = controller.getBridgeUrl();
    if (!origin) throw new Error("Dano test server did not start");
    const aliceToken = signUser("alice-workspace", "Alice");
    const bobToken = signUser("bob-workspace", "Bob");
    const alice = await createClient(origin, aliceToken);
    const bob = await createClient(origin, bobToken);
    fs.writeFileSync(
      path.join(alice.defaultWorkspacePath, "alice-secret.txt"),
      "Alice only",
      "utf8",
    );
    execFileSync("git", ["init", "-b", "main"], {
      cwd: alice.defaultWorkspacePath,
      stdio: "ignore",
    });

    const aliceGit = await executeCommand(origin, alice, aliceToken, {
      id: "alice-git",
      type: "list_git_branches",
    });
    expect(aliceGit.payload).toMatchObject({
      command: "list_git_branches",
      success: true,
    });
    const bobGit = await executeCommand(origin, bob, bobToken, {
      id: "bob-git",
      type: "list_git_branches",
    });
    expect(bobGit.payload).toMatchObject({
      command: "list_git_branches",
      success: false,
    });

    const listed = await executeCommand(origin, bob, bobToken, {
      id: "bob-forged-workspace-list",
      type: "list_workspace_entries",
      workspacePath: alice.defaultWorkspacePath,
      force: true,
    });
    expect(listed.payload).toMatchObject({
      command: "list_workspace_entries",
      success: false,
    });

    const read = await executeCommand(origin, bob, bobToken, {
      id: "bob-forged-workspace-read",
      type: "read_workspace_file",
      workspacePath: alice.defaultWorkspacePath,
      path: "alice-secret.txt",
    });
    expect(read.payload).toMatchObject({
      command: "read_workspace_file",
      success: false,
    });

    const created = await executeCommand(origin, bob, bobToken, {
      id: "bob-forged-workspace-session",
      type: "new_session",
      workspacePath: alice.defaultWorkspacePath,
    });
    expect(created.payload).toMatchObject({
      command: "new_session",
      success: false,
    });
  });
});
