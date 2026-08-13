import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const checker = path.join(repositoryRoot, "scripts/check-anonymous-release-gate.mjs");
const runner = path.join(repositoryRoot, "scripts/run-anonymous-release-gate.ts");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("real Anonymous User release gate", () => {
  it("prepares browser markers without a fillable result checklist", () => {
    const root = temporaryRoot();
    expect(run("prepare", root).status).toBe(0);
    const evidence = read(path.join(root, "evidence.json"));

    expect(evidence).toMatchObject({
      schemaVersion: 2,
      capture: {
        browserContexts: { a: "codex-in-app-browser", b: "chrome" },
        originMode: "single-dano-origin",
        seam: "Dano HTTP/SSE and visible acceptance UI",
      },
      cleanup: { idleTtlMs: 1_000, intervalMs: 50, clockAdvanceMs: 2_000 },
    });
    expect(evidence).not.toHaveProperty("observations");
    expect(JSON.stringify(evidence)).not.toMatch(
      /password|cookie|authorization|access.?token|refresh.?token|https?:\/\//i,
    );
    expect(fs.readFileSync(path.join(root, "ledger.ndjson"), "utf8")).toBe("");
  });

  it("ships a visible UI harness over the production HTTP/SSE server", () => {
    const source = fs.readFileSync(runner, "utf8");
    expect(source).toContain("startDanoServer(");
    expect(source).toContain("createAnonymousUserContextResolver(");
    expect(source).toContain("createJwtUserContextResolver(");
    expect(source).toContain('type: "prompt"');
    expect(source).toContain('text/event-stream');
    expect(source).toContain("/api/uploads");
    expect(source).toContain("/preferences/theme");
    expect(source).not.toMatch(/page\.evaluate|localStorage|sessionStorage|document\.cookie/);
  });

  it("rejects an unsigned or hand-edited observation ledger", () => {
    const root = temporaryRoot();
    expect(run("prepare", root).status).toBe(0);
    const evidencePath = path.join(root, "evidence.json");
    const evidence = read(evidencePath);
    const { publicKey } = generateKeyPairSync("ed25519");
    evidence.attestation = {
      algorithm: "Ed25519",
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    fs.writeFileSync(
      path.join(root, "ledger.ndjson"),
      `${JSON.stringify({ sequence: 1, type: "own", passed: true })}\n`,
    );

    const result = run("verify", root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/complete signed observations|unexpected fields|signature/i);
  });

  it("requires the complete signed browser and cleanup timeline", () => {
    const root = temporaryRoot();
    expect(run("prepare", root).status).toBe(0);
    const evidencePath = path.join(root, "evidence.json");
    const evidence = read(evidencePath);
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    evidence.attestation = {
      algorithm: "Ed25519",
      publicKey: publicKey.export({ type: "spki", format: "pem" }),
      startedAt: new Date().toISOString(),
    };
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const record = {
      sequence: 1,
      type: "own",
      runId: evidence.runId,
      occurredAt: new Date().toISOString(),
      slot: "a",
      authenticationStatus: "anonymous",
      markerSha256: "a".repeat(64),
      ownerFingerprint: "b".repeat(64),
      clientFingerprint: "c".repeat(64),
      workspaceFingerprint: "d".repeat(64),
      uploadFingerprint: "e".repeat(64),
      ownPreviewHttpStatus: 200,
      ownPreviewSha256: "a".repeat(64),
    };
    const signature = sign(null, Buffer.from(JSON.stringify(record)), privateKey).toString("base64url");
    fs.writeFileSync(
      path.join(root, "ledger.ndjson"),
      `${JSON.stringify({ ...record, signature })}\n`,
    );

    const result = run("verify", root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("complete signed observations");
  });

  it("produces the complete evidence through public HTTP/SSE boundaries", async () => {
    const root = temporaryRoot();
    expect(run("prepare", root).status).toBe(0);
    const port = await freePort();
    const child = spawn(
      process.execPath,
      [
        "--import",
        path.join(repositoryRoot, "apps/dano/node_modules/jiti/lib/jiti-register.mjs"),
        runner,
        root,
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, DANO_ANONYMOUS_GATE_PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", chunk => (output += chunk.toString()));
    child.stderr.on("data", chunk => (output += chunk.toString()));
    await waitFor(() => output.includes("[anonymous-gate] ready"), () => output);
    const origin = `http://127.0.0.1:${port}`;
    const streams: http.ClientRequest[] = [];
    try {
      const a = await createClient(origin);
      const b = await createClient(origin);
      streams.push(await openSse(origin, b.client.eventsUrl, b.cookie));
      await action(origin, "own", "a", a.cookie);
      await action(origin, "own", "b", b.cookie);
      await action(origin, "cross", "a", a.cookie);
      await action(origin, "cross", "b", b.cookie);
      await action(origin, "idle-sweep", "b", b.cookie);

      const a2 = await createClient(origin, a.cookie);
      await action(origin, "own", "a2", a2.cookie);
      await action(origin, "turn-start", "a2", a2.cookie);
      await action(origin, "turn-protected", "b", b.cookie);
      await action(origin, "turn-release", "b", b.cookie);
      await action(origin, "post-turn-sweep", "b", b.cookie);

      const authentication = await action(
        origin,
        "authenticate",
        "authenticated",
        a2.cookie,
      );
      const authCookie = cookieFrom(authentication);
      const authenticated = await createClient(origin, `${a2.cookie}; ${authCookie}`);
      streams.push(
        await openSse(
          origin,
          authenticated.client.eventsUrl,
          `${a2.cookie}; ${authCookie}`,
        ),
      );
      await action(origin, "own", "authenticated", `${a2.cookie}; ${authCookie}`);
      await action(
        origin,
        "authenticated-retained",
        "authenticated",
        `${a2.cookie}; ${authCookie}`,
      );

      const verified = run("verify", root);
      expect(verified.status, `${verified.stderr}\n${output}`).toBe(0);
      expect(verified.stdout).toContain("real Anonymous User release gate passed");

      const bRecord = fs
        .readFileSync(path.join(root, "ledger.ndjson"), "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .find(record => record.type === "own" && record.slot === "b");
      const uploadRecord = findUploadRecord(
        path.join(root, "runtime", "uploads", "records"),
        bRecord.uploadFingerprint,
      );
      fs.writeFileSync(uploadRecord.path, "tampered after signed browser capture");
      const tampered = run("verify", root);
      expect(tampered.status).toBe(1);
      expect(tampered.stderr).toContain("retained upload content does not match");
    } finally {
      for (const stream of streams) stream.destroy();
      child.kill("SIGTERM");
      await new Promise<void>(resolve => child.once("exit", () => resolve()));
    }
  }, 35_000);
});

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-anonymous-gate-"));
  roots.push(root);
  return root;
}

function run(command: "prepare" | "verify", root: string) {
  return spawnSync(process.execPath, [checker, command, root], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
}

function read(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
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
    cookie: cookieFrom(response) || cookie!,
    client: (await response.json()) as { eventsUrl: string },
  };
}

async function action(
  origin: string,
  action: string,
  slot: string,
  cookie: string,
) {
  const response = await fetch(`${origin}/api/acceptance/anonymous/${action}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ slot }),
  });
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status}): ${await response.text()}`);
  }
  return response;
}

function cookieFrom(response: Response) {
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

async function openSse(origin: string, eventsUrl: string, cookie: string) {
  const request = http.get(`${origin}${eventsUrl}`, { headers: { Cookie: cookie } });
  await new Promise<void>((resolve, reject) => {
    request.once("response", () => resolve());
    request.once("error", reject);
  });
  return request;
}

async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no test port");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function waitFor(predicate: () => boolean, details: () => string) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out:\n${details()}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function findUploadRecord(root: string, fingerprint: string) {
  for (const file of fs.readdirSync(root)) {
    const stored = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    const upload = stored.upload ?? stored;
    const actual = createHash("sha256").update(upload.id).digest("hex");
    if (actual === fingerprint) return upload as { path: string };
  }
  throw new Error("upload record was not found");
}
