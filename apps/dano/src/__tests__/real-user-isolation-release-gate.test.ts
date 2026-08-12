import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = new URL("../../../../", import.meta.url);
const gateScript = new URL(
  "../../../../scripts/check-real-user-isolation.mjs",
  import.meta.url,
).pathname;
const manifestPath = new URL(
  "./fixtures/real-oauth-acceptance.json",
  import.meta.url,
).pathname;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const directory of temporaryRoots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("real OAuth User isolation release gate", () => {
  it("records the two controlled test accounts without a provider address", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schemaVersion: number;
      accounts: Array<{
        slot: string;
        username: string;
        password: string;
        preference: string;
      }>;
      releaseGate: {
        browser: string;
        publicSeam: string;
        browserInput: string[];
        automatedContract: string[];
      };
    };

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.accounts).toEqual([
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
      ]);
    expect(manifest.releaseGate).toEqual({
      browser: "codex-in-app-browser",
      publicSeam: "Dano HTTP/Bridge",
      browserInput: [
        "two authenticated browser contexts",
        "own and cross resource observations",
      ],
      automatedContract: [
        "distinct canonical User owner fingerprints",
        "cross probes target the counterpart browser context resources from the same run",
        "bidirectional session, transcript, workspace, upload, and preference isolation",
      ],
    });
    expect(JSON.stringify(manifest)).not.toMatch(/https?:\/\//i);
  });

  it("publishes the real-browser evidence gate separately from fake-provider tests", () => {
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

  it("prepares a fresh browser evidence template without copying credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "dano-real-user-gate-"));
    temporaryRoots.push(directory);
    const evidencePath = join(directory, "evidence.json");

    execFileSync(
      process.execPath,
      [gateScript, "prepare", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );
    const raw = readFileSync(evidencePath, "utf8");
    const evidence = JSON.parse(raw) as {
      schemaVersion: number;
      runId: string;
      accounts: Array<{
        slot: string;
        username: string;
        marker: string;
        observations: unknown;
      }>;
    };

    expect(evidence.schemaVersion).toBe(1);
    expect(evidence.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(evidence.accounts.map(account => account.username)).toEqual([
      "dano424a",
      "dano424b",
    ]);
    expect(evidence.accounts[0]?.marker).not.toBe(evidence.accounts[1]?.marker);
    expect(evidence.accounts[0]?.observations).toEqual({
      authenticationStatus: null,
      runtimeOwnerFingerprint: null,
      own: {
        resourceFingerprints: {
          client: null,
          session: null,
          workspace: null,
          upload: null,
        },
        sessionMarkerCount: null,
        sessionOpen: null,
        transcriptMarkerCount: null,
        workspaceMarkerSha256: null,
        uploadPreviewSha256: null,
        preference: null,
      },
      cross: {
        targetFingerprints: {
          client: null,
          session: null,
          workspace: null,
          upload: null,
        },
        sessionMarkerCount: null,
        sessionOpen: null,
        transcriptMarkerCount: null,
        workspaceRead: null,
        uploadPreviewHttpStatus: null,
        preferenceReadHttpStatus: null,
      },
    });
    expect(raw).not.toContain("Dano424Test!");
    expect(raw).not.toMatch(/https?:\/\//i);
  });

  it("accepts only complete, bidirectional public-boundary observations", () => {
    const directory = mkdtempSync(join(tmpdir(), "dano-real-user-gate-"));
    temporaryRoots.push(directory);
    const evidencePath = join(directory, "evidence.json");
    execFileSync(
      process.execPath,
      [gateScript, "prepare", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as any;
    evidence.completedAt = new Date().toISOString();
    evidence.accounts[0].observations = passingObservations({
      runtimeOwnerFingerprint: "a".repeat(64),
      preference: "blue",
      marker: evidence.accounts[0].marker,
      resourceSeed: "a",
      crossResourceSeed: "b",
    });
    evidence.accounts[1].observations = passingObservations({
      runtimeOwnerFingerprint: "b".repeat(64),
      preference: "purple",
      marker: evidence.accounts[1].marker,
      resourceSeed: "b",
      crossResourceSeed: "a",
    });
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const output = execFileSync(
      process.execPath,
      [gateScript, "verify", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );

    expect(output).toContain("Real OAuth User isolation evidence contract passed");
  });

  it("rejects same-owner evidence and any successful cross-User probe", () => {
    const directory = mkdtempSync(join(tmpdir(), "dano-real-user-gate-"));
    temporaryRoots.push(directory);
    const evidencePath = join(directory, "evidence.json");
    execFileSync(
      process.execPath,
      [gateScript, "prepare", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as any;
    evidence.completedAt = new Date().toISOString();
    evidence.accounts[0].observations = passingObservations({
      runtimeOwnerFingerprint: "a".repeat(64),
      preference: "blue",
      marker: evidence.accounts[0].marker,
      resourceSeed: "a",
      crossResourceSeed: "b",
    });
    evidence.accounts[1].observations = passingObservations({
      runtimeOwnerFingerprint: "a".repeat(64),
      preference: "purple",
      marker: evidence.accounts[1].marker,
      resourceSeed: "b",
      crossResourceSeed: "a",
    });
    evidence.accounts[1].observations.cross.workspaceRead = "succeeded";
    evidence.accounts[1].observations.cross.targetFingerprints.workspace =
      "c".repeat(64);
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const result = spawnSync(
      process.execPath,
      [gateScript, "verify", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("different canonical User owners");
    expect(result.stderr).toContain("cross.workspaceRead must be rejected");
    expect(result.stderr).toContain(
      "cross.targetFingerprints.workspace must equal",
    );
  });

  it("rejects forbidden provider and credential material in evidence", () => {
    const directory = mkdtempSync(join(tmpdir(), "dano-real-user-gate-"));
    temporaryRoots.push(directory);
    const evidencePath = join(directory, "evidence.json");
    execFileSync(
      process.execPath,
      [gateScript, "prepare", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as any;
    evidence.completedAt = new Date().toISOString();
    evidence.accounts[0].observations = passingObservations({
      runtimeOwnerFingerprint: "a".repeat(64),
      preference: "blue",
      marker: evidence.accounts[0].marker,
      resourceSeed: "a",
      crossResourceSeed: "b",
    });
    evidence.accounts[1].observations = passingObservations({
      runtimeOwnerFingerprint: "b".repeat(64),
      preference: "purple",
      marker: evidence.accounts[1].marker,
      resourceSeed: "b",
      crossResourceSeed: "a",
    });
    evidence.providerAddress = "https://provider.invalid";
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

    const result = spawnSync(
      process.execPath,
      [gateScript, "verify", evidencePath, "--manifest", manifestPath],
      { cwd: new URL(".", root), encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("forbidden provider or credential material");
  });
});

function passingObservations(options: {
  runtimeOwnerFingerprint: string;
  preference: "blue" | "purple";
  marker: string;
  resourceSeed: string;
  crossResourceSeed: string;
}) {
  const markerSha256 = createHash("sha256").update(options.marker).digest("hex");
  const fingerprints = resourceFingerprints(options.resourceSeed);
  return {
    authenticationStatus: "authenticated",
    runtimeOwnerFingerprint: options.runtimeOwnerFingerprint,
    own: {
      resourceFingerprints: fingerprints,
      sessionMarkerCount: 1,
      sessionOpen: "succeeded",
      transcriptMarkerCount: 1,
      workspaceMarkerSha256: markerSha256,
      uploadPreviewSha256: markerSha256,
      preference: options.preference,
    },
    cross: {
      targetFingerprints: resourceFingerprints(options.crossResourceSeed),
      sessionMarkerCount: 0,
      sessionOpen: "rejected",
      transcriptMarkerCount: 0,
      workspaceRead: "rejected",
      uploadPreviewHttpStatus: 403,
      preferenceReadHttpStatus: 403,
    },
  };
}

function resourceFingerprints(seed: string) {
  return Object.fromEntries(
    ["client", "session", "workspace", "upload"].map(resource => [
      resource,
      createHash("sha256").update(`${seed}:${resource}`).digest("hex"),
    ]),
  );
}
