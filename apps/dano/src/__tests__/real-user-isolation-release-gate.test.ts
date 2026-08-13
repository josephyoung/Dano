import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";

const root = new URL("../../../../", import.meta.url);
const gateScript = new URL(
  "../../../../scripts/check-real-user-isolation.mjs",
  import.meta.url,
).pathname;
const browserProducer = new URL(
  "../../../../scripts/real-user-isolation-browser.mjs",
  import.meta.url,
).pathname;
const manifestPath = new URL(
  "./fixtures/real-oauth-acceptance.json",
  import.meta.url,
).pathname;
const temporaryRoots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit").catch(() => {});
  }
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("real OAuth User isolation release gate", () => {
  it("records only the two controlled test accounts and public Dano seam", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    expect(manifest).toEqual({
      schemaVersion: 2,
      releaseGate: {
        browserContexts: {
          a: "codex-in-app-browser",
          b: "chrome",
        },
        callbackMode: "single-shared-dano-callback",
        publicSeam: "Dano HTTP/SSE/UI",
      },
      accounts: [
        {
          slot: "a",
          username: "dano424a",
          password: "Dano424Test!",
          preference: "blue",
        },
        {
          slot: "b",
          username: "dano424b",
          password: "Dano424Test!",
          preference: "purple",
        },
      ],
    });
    expect(JSON.stringify(manifest)).not.toMatch(/https?:\/\//i);
  });

  it("ships a browser producer that performs the live public-boundary probes", () => {
    const source = readFileSync(browserProducer, "utf8");

    for (const seam of [
      "/api/auth/current",
      "/api/clients",
      "eventsUrl",
      "messagesUrl",
      "/api/uploads",
      "/preferences/theme",
      "new_session",
      "list_sessions",
      "switch_session",
      "list_tree_entries",
      "list_workspace_entries",
      "read_workspace_file",
      "register_workspace",
    ]) {
      expect(source).toContain(seam);
    }
    expect(source).not.toMatch(/client.?secret|access.?token|refresh.?token/i);
    expect(source).not.toMatch(/dano424[ab]/i);
  });

  it("publishes the live gate separately from deterministic fake-provider tests", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["test:auth-real-users"]).toBe(
      "node scripts/check-real-user-isolation.mjs",
    );
    expect(packageJson.scripts?.["test:auth-release"]).not.toContain(
      "check-real-user-isolation.mjs",
    );
  });

  it("does not expose a fillable prepare mode", () => {
    const directory = tempDirectory();
    const evidencePath = join(directory, "evidence.json");
    const result = spawnSync(
      process.execPath,
      [gateScript, "prepare", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("capture");
    expect(() => readFileSync(evidencePath)).toThrow();
  });

  it("emits live HTTP/SSE/Pi collector PASS without claiming browser surface provenance", async () => {
    const directory = tempDirectory();
    const evidencePath = join(directory, "evidence.json");
    const capture = await startCapture(evidencePath);

    const a = await captureSlot(capture.urls.a, "a", "blue", "owner-a");
    const b = await captureSlot(capture.urls.b, "b", "purple", "owner-b");
    await submitCross(a, b, "a", "succeeded", 400);
    await submitCross(a, b, "a");
    await submitCross(b, a, "b");
    await capture.exit;

    const raw = readFileSync(evidencePath, "utf8");
    const evidence = JSON.parse(raw);
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.capture).toMatchObject({
      expectedBrowserContexts: {
        a: "codex-in-app-browser",
        b: "chrome",
      },
      callbackMode: "single-shared-dano-callback",
      seam: "Dano HTTP/SSE/UI",
      producer: "live-browser-module",
      producerSha256: createHash("sha256")
        .update(readFileSync(browserProducer))
        .digest("hex"),
    });
    expect(evidence.accounts.map((account: any) => account.runtimeOwnerFingerprint))
      .toEqual([sha256("owner-a"), sha256("owner-b")]);
    expect(evidence.recordPurpose).toBe("redacted-audit-only-not-live-proof");
    expect(evidence).not.toHaveProperty("attestation");
    expect(capture.output()).toContain("LIVE HTTP/SSE/Pi COLLECTOR PASS:");
    expect(capture.output()).toContain("external IAB/Chrome acceptance record");
    expect(raw).not.toMatch(/raw-(?:client|session|workspace|upload)/);
    expect(raw).not.toContain("Dano424Test!");
    expect(raw).not.toMatch(/https?:\/\//i);
    expect(raw).not.toMatch(/password|cookie|authorization|client.?secret|access.?token|refresh.?token/i);

    const output = execFileSync(
      process.execPath,
      [gateScript, "audit", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );
    expect(output).toContain("AUDIT ONLY (NOT LIVE COLLECTOR PASS)");

    evidence.accounts[0].cross.sessionOpen = "succeeded";
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    const tampered = spawnSync(
      process.execPath,
      [gateScript, "audit", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain("sessionOpen");
  });

  it("refuses offline verify instead of claiming live or browser surface provenance", () => {
    const directory = tempDirectory();
    const evidencePath = join(directory, "evidence.json");
    writeFileSync(
      evidencePath,
      JSON.stringify({
        schemaVersion: 2,
        completedAt: new Date().toISOString(),
        accounts: [
          { slot: "a", runtimeOwnerFingerprint: "a".repeat(64) },
          { slot: "b", runtimeOwnerFingerprint: "b".repeat(64) },
        ],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [gateScript, "verify", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cannot prove a live collector run or browser surface provenance");
    expect(result.stdout).not.toContain("COLLECTOR PASS");
  });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dano-real-user-gate-"));
  temporaryRoots.push(directory);
  return directory;
}

async function startCapture(evidencePath: string): Promise<{
  urls: Record<"a" | "b", URL>;
  exit: Promise<void>;
  output(): string;
}> {
  const child = spawn(
    process.execPath,
    [
      gateScript,
      "capture",
      evidencePath,
      "--manifest",
      manifestPath,
      "--origin",
      "http://localhost:5173",
      "--port",
      "0",
      "--timeout-ms",
      "10000",
    ],
    { cwd: new URL(".", root), stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", chunk => {
    stdout += chunk;
  });
  child.stderr!.on("data", chunk => {
    stderr += chunk;
  });
  const deadline = Date.now() + 5_000;
  while (!stdout.includes("SLOT_B=")) {
    if (child.exitCode !== null) {
      throw new Error(`capture exited early: ${stderr || stdout}`);
    }
    if (Date.now() > deadline) throw new Error(`capture did not start: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const url = (slot: "A" | "B") => {
    const match = new RegExp(`SLOT_${slot}=(http[^\\s]+)`).exec(stdout);
    if (!match?.[1]) throw new Error(`missing slot ${slot} URL in ${stdout}`);
    return new URL(match[1]);
  };
  return {
    urls: { a: url("A"), b: url("B") },
    output: () => stdout,
    exit: once(child, "exit").then(([code]) => {
      if (code !== 0) throw new Error(`capture failed: ${stderr || stdout}`);
    }),
  };
}

type CapturedSlot = {
  collector: string;
  token: string;
  slot: "a" | "b";
  raw: {
    clientId: string;
    sessionPath: string;
    workspacePath: string;
    uploadId: string;
    uploadRelativePath: string;
  };
};

async function captureSlot(
  moduleUrl: URL,
  slot: "a" | "b",
  preference: string,
  owner: string,
): Promise<CapturedSlot> {
  const collector = moduleUrl.origin;
  const token = moduleUrl.searchParams.get("token");
  expect(token).toBeTruthy();
  const configResponse = await fetch(
    `${collector}/config?slot=${slot}&token=${token}`,
    { headers: { Origin: "http://localhost:5173" } },
  );
  expect(configResponse.status).toBe(200);
  const config = await configResponse.json() as { marker: string; preference: string };
  expect(config.preference).toBe(preference);
  const raw = {
    clientId: `raw-client-${slot}`,
    sessionPath: `/raw-session-${slot}`,
    workspacePath: `/raw-workspace-${slot}`,
    uploadId: `raw-upload-${slot}`,
    uploadRelativePath: `uploads/raw-${slot}.txt`,
  };
  const own = {
    authenticationStatus: "authenticated",
    runtimeOwnerFingerprint: sha256(owner),
    raw,
    own: {
      resourceFingerprints: fingerprints(raw),
      sessionMarkerCount: 1,
      sessionOpen: "succeeded",
      transcriptMarkerCount: 1,
      workspaceMarkerSha256: sha256(config.marker),
      uploadPreviewSha256: sha256(config.marker),
      preference,
    },
  };
  const response = await fetch(`${collector}/own?slot=${slot}&token=${token}`, {
    method: "POST",
    headers: {
      Origin: "http://localhost:5173",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(own),
  });
  expect(response.status).toBe(202);
  return { collector, token: token!, slot, raw };
}

async function submitCross(
  current: CapturedSlot,
  counterpart: CapturedSlot,
  slot: "a" | "b",
  sessionOpen = "rejected",
  expectedStatus = 202,
): Promise<void> {
  const peerResponse = await fetch(
    `${current.collector}/peer?slot=${slot}&token=${current.token}`,
    { headers: { Origin: "http://localhost:5173" } },
  );
  expect(peerResponse.status).toBe(200);
  await expect(peerResponse.json()).resolves.toEqual(counterpart.raw);
  const response = await fetch(
    `${current.collector}/cross?slot=${slot}&token=${current.token}`,
    {
      method: "POST",
      headers: {
        Origin: "http://localhost:5173",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetFingerprints: fingerprints(counterpart.raw),
        forgedClientHttpStatus: 403,
        sessionList: "rejected",
        sessionOpen,
        transcriptRead: "rejected",
        workspaceRegister: "rejected",
        workspaceList: "rejected",
        workspaceRead: "rejected",
        uploadPreviewHttpStatus: 403,
        preferenceReadHttpStatus: 403,
        preferenceRestored: true,
      }),
    },
  );
  expect(response.status).toBe(expectedStatus);
}

function fingerprints(raw: CapturedSlot["raw"]): Record<string, string> {
  return {
    client: sha256(raw.clientId),
    session: sha256(raw.sessionPath),
    workspace: sha256(raw.workspacePath),
    upload: sha256(raw.uploadId),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
