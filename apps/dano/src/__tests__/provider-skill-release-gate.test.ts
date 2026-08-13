import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  SessionManager,
  createAgentSession,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialBroker } from "../bridge/credential-broker.js";

const roots: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const gateScript = path.join(
  repositoryRoot,
  "scripts/check-provider-skill-release-gate.mjs",
);
const gateEnvironment = {
  DANO_PROVIDER_ACCEPTANCE_PATH: "/acceptance/profile",
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("real provider Skill release gate", () => {
  it("publishes the real Skill verifier separately from fake-provider tests", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.["test:auth-real-provider-skill"]).toBe(
      "node scripts/check-provider-skill-release-gate.mjs verify",
    );
    expect(packageJson.scripts?.["test:auth-release"]).not.toContain(
      "check-provider-skill-release-gate.mjs verify",
    );
  });

  it("installs a provider-independent Skill and releases one held Turn", () => {
    const root = temporaryRoot();
    const agentDir = path.join(root, "agent");
    expect(runGate("install", { PI_CODING_AGENT_DIR: agentDir }).status).toBe(0);

    const installed = fs.readFileSync(
      path.join(agentDir, "skills/provider-broker-release-gate/SKILL.md"),
      "utf8",
    );
    expect(installed).toContain('path: "/acceptance/profile"');
    expect(installed).not.toMatch(/https?:\/\/|authorization|cookie|token/i);
    expect(installed.indexOf("`bash`")).toBeLessThan(
      installed.indexOf("`provider_request`"),
    );
    expect(installed).not.toContain("{{");

    expect(
      runGate("release", { PI_CODING_AGENT_DIR: agentDir }, ["gate-a-before"])
        .status,
    ).toBe(0);
    const waitResult = spawnSync(
      process.execPath,
      [
        path.join(
          agentDir,
          "skills/provider-broker-release-gate/wait-for-release.mjs",
        ),
        "gate-a-before",
      ],
      { encoding: "utf8" },
    );
    expect(waitResult.status).toBe(0);
    expect(waitResult.stdout).toContain("released gate-a-before");
  });

  it("loads the installed Skill in a real Pi Turn and calls provider_request", async () => {
    const root = temporaryRoot();
    const agentDir = path.join(root, "agent");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace, { recursive: true });
    expect(runGate("install", { PI_CODING_AGENT_DIR: agentDir }).status).toBe(0);

    const modelProvider = fauxProvider({ provider: "provider-skill-release-gate" });
    modelProvider.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("provider_request", {
            method: "GET",
            path: gateEnvironment.DANO_PROVIDER_ACCEPTANCE_PATH,
          }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("gate complete"),
    ]);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: null,
    });
    modelRuntime.registerNativeProvider(modelProvider.provider);
    await modelRuntime.setRuntimeApiKey(modelProvider.provider.id, "test-only");
    const providerFetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const credentialBroker = new CredentialBroker({
      providerApiOrigin: "https://provider.test",
      readCredential: async sessionId =>
        sessionId === "login-a" ? { accessToken: "access-a" } : null,
      fetch: providerFetch as typeof fetch,
    });
    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      modelRuntime,
      model: modelProvider.getModel(),
      thinkingLevel: "off",
      noTools: "builtin",
      customTools: [credentialBroker.createTool("user-a")],
      sessionManager: SessionManager.create(workspace, path.join(root, "sessions")),
    });
    credentialBroker.observe("user-a", session);
    credentialBroker.queueAssistantTurn("user-a", session.sessionId, "login-a");

    try {
      expect(
        session.resourceLoader
          .getSkills()
          .skills.some(skill => skill.name === "provider-broker-release-gate"),
      ).toBe(true);
      await session.prompt("/skill:provider-broker-release-gate gate-a-before");
      expect(providerFetch).toHaveBeenCalledOnce();
      const transcript = fs.readFileSync(session.sessionFile!, "utf8");
      expect(transcript).toContain("provider_request");
      expect(transcript).not.toContain("access-a");
    } finally {
      session.dispose();
    }
  });

  it("prepares an evidence template without provider or credential data", () => {
    const root = temporaryRoot();
    const evidencePath = path.join(root, "evidence.json");
    const result = runGate("prepare", {}, [evidencePath]);

    expect(result.status).toBe(0);
    const raw = fs.readFileSync(evidencePath, "utf8");
    const evidence = JSON.parse(raw) as any;
    expect(evidence.capture).toEqual({
      browserContexts: {
        a: "codex-in-app-browser",
        b: "chrome",
      },
      callbackMode: "single-shared-dano-callback",
      seam: "Dano HTTP/SSE and Pi transcript",
    });
    expect(evidence.observations.sequence).toMatchObject({
      logoutHttpStatus: null,
      aOldClientHttpStatus: null,
      bAfterLogoutStatus: null,
    });
    expect(raw).not.toMatch(
      /https?:\/\/|password|client.?secret|token|cookie|authorization/i,
    );
  });

  it("accepts only linked same-User, same-session, ordered public evidence", () => {
    const fixture = passingEvidence();
    expect(verifyFixture(fixture).status).toBe(0);
  });

  it.each([
    {
      label: "Login Session A captured outside the Codex in-app Browser",
      mutate: (value: any) => {
        value.capture.browserContexts.a = "chrome";
      },
    },
    {
      label: "Login Session B captured outside Chrome",
      mutate: (value: any) => {
        value.capture.browserContexts.b = "codex-in-app-browser";
      },
    },
    {
      label: "more than one Dano callback",
      mutate: (value: any) => {
        value.capture.callbackMode = "separate-callbacks";
      },
    },
  ])("rejects $label", ({ mutate }) => {
    const fixture = passingEvidence();
    const evidence = JSON.parse(fs.readFileSync(fixture.evidencePath, "utf8"));
    mutate(evidence);
    fs.writeFileSync(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(verifyFixture(fixture).status).toBe(1);
  });

  it.each([
    {
      label: "different canonical User ID fingerprints",
      mutate: (value: any) => {
        value.observations.identity.bUserIdFingerprint = "b".repeat(64);
      },
    },
    {
      label: "the same Browser Client for both Login Sessions",
      mutate: (value: any) => {
        value.observations.identity.bClientFingerprint =
          value.observations.identity.aClientFingerprint;
      },
    },
    {
      label: "different Agent Session fingerprints",
      mutate: (value: any) => {
        value.observations.sharedRuntime.bSessionFingerprint = "b".repeat(64);
      },
    },
    {
      label: "logout after the held provider result",
      mutate: (value: any) => {
        value.observations.sequence.logoutAt = "2026-08-12T00:00:02.500Z";
      },
    },
    {
      label: "still-live old client",
      mutate: (value: any) => {
        value.observations.sequence.aOldClientHttpStatus = 202;
      },
    },
    {
      label: "identical event timestamps",
      mutate: (value: any) => {
        for (const field of Object.keys(value.observations.sequence)) {
          if (field.endsWith("At")) {
            value.observations.sequence[field] = "2026-08-12T00:00:04.000Z";
          }
        }
      },
    },
  ])("rejects $label", ({ mutate }) => {
    const fixture = passingEvidence();
    const evidence = JSON.parse(fs.readFileSync(fixture.evidencePath, "utf8"));
    mutate(evidence);
    fs.writeFileSync(fixture.evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    expect(verifyFixture(fixture).status).toBe(1);
  });

  it("rejects a directory and duplicate matching tool results", () => {
    const fixture = passingEvidence();
    expect(
      runGate(
        "verify",
        { DANO_PROVIDER_GATE_SESSION: path.dirname(fixture.transcriptPath) },
        [fixture.evidencePath],
      ).status,
    ).toBe(1);

    const lines = fs.readFileSync(fixture.transcriptPath, "utf8").trim().split("\n");
    const providerResult = [...lines]
      .reverse()
      .find(line => line.includes('"toolName":"provider_request"'));
    expect(providerResult).toBeTruthy();
    fs.appendFileSync(fixture.transcriptPath, `${providerResult!}\n`);
    expect(verifyFixture(fixture).status).toBe(1);
  });

  it.each([
    {
      label: "a different relative path",
      mutate: (entries: any[]) => {
        const call = entries.find(entry =>
          textOf(entry).includes('"path":"/acceptance/profile"'),
        );
        call.message.content[0].arguments.path = "/different";
      },
    },
    {
      label: "a provider result before its call",
      mutate: (entries: any[]) => {
        const callIndex = entries.findIndex(entry =>
          textOf(entry).includes('"name":"provider_request"'),
        );
        const resultIndex = entries.findIndex(
          (entry, index) =>
            index > callIndex && textOf(entry).includes('"toolName":"provider_request"'),
        );
        [entries[callIndex], entries[resultIndex]] = [
          entries[resultIndex],
          entries[callIndex],
        ];
      },
    },
  ])("rejects $label", ({ mutate }) => {
    const fixture = passingEvidence();
    const entries = fs
      .readFileSync(fixture.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    mutate(entries);
    fs.writeFileSync(
      fixture.transcriptPath,
      `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`,
    );
    expect(verifyFixture(fixture).status).toBe(1);
  });
});

function passingEvidence() {
  const root = temporaryRoot();
  const evidencePath = path.join(root, "evidence.json");
  expect(runGate("prepare", {}, [evidencePath]).status).toBe(0);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8")) as any;
  const transcriptPath = path.join(root, "shared-session.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${[
      ...turnEntries(evidence.markers.aBefore, "success", [0, 200, 500, 700, 1_000]),
      ...turnEntries(
        evidence.markers.aAfter,
        "authentication_required",
        [2_000, 3_000, 5_000, 5_500, 6_000],
      ),
      ...turnEntries(evidence.markers.bAfter, "success", [7_000, 7_200, 7_500, 7_700, 8_000]),
    ].map(entry => JSON.stringify(entry)).join("\n")}\n`,
  );
  const sameUserId = "a".repeat(64);
  const sameSession = sha256(path.resolve(transcriptPath));
  evidence.completedAt = "2026-08-12T00:00:09.000Z";
  evidence.observations.identity = {
    aStatus: "authenticated",
    bStatus: "authenticated",
    aClientFingerprint: "1".repeat(64),
    aAfterClientFingerprint: "1".repeat(64),
    bClientFingerprint: "2".repeat(64),
    aUserIdFingerprint: sameUserId,
    bUserIdFingerprint: sameUserId,
    aPreference: evidence.markers.sharedPreference,
    bPreference: evidence.markers.sharedPreference,
  };
  evidence.observations.sharedRuntime = {
    aSessionFingerprint: sameSession,
    bSessionFingerprint: sameSession,
    bSwitchStatus: "succeeded",
  };
  evidence.observations.sequence = {
    aBeforeAcceptedAt: "2026-08-12T00:00:00.000Z",
    aBeforeResultAt: "2026-08-12T00:00:01.000Z",
    aAfterAcceptedAt: "2026-08-12T00:00:02.000Z",
    aAfterWaitStartedAt: "2026-08-12T00:00:03.000Z",
    logoutAt: "2026-08-12T00:00:04.000Z",
    logoutHttpStatus: 200,
    aOldClientHttpStatus: 404,
    bAfterLogoutStatus: "authenticated",
    aAfterReleasedAt: "2026-08-12T00:00:05.000Z",
    aAfterResultAt: "2026-08-12T00:00:06.000Z",
    bAfterAcceptedAt: "2026-08-12T00:00:07.000Z",
    bAfterResultAt: "2026-08-12T00:00:08.000Z",
  };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  return { evidencePath, transcriptPath };
}

function verifyFixture(fixture: {
  evidencePath: string;
  transcriptPath: string;
}) {
  return runGate(
    "verify",
    { DANO_PROVIDER_GATE_SESSION: fixture.transcriptPath },
    [fixture.evidencePath],
  );
}

function turnEntries(
  marker: string,
  outcome: "success" | "authentication_required",
  offsets: readonly [number, number, number, number, number],
) {
  const releaseId = `release-${marker}`;
  const providerId = `provider-${marker}`;
  const details =
    outcome === "success"
      ? { ok: true, status: 200 }
      : { ok: false, error: { code: "authentication_required" } };
  return [
    message({
      role: "user",
      content: `<skill name="provider-broker-release-gate">${marker}</skill>`,
      timestamp: timestamp(offsets[0]),
    }),
    message({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: releaseId,
          name: "bash",
          arguments: {
            command: `node "/test/wait-for-release.mjs" "${marker}"`,
          },
        },
      ],
      timestamp: timestamp(offsets[1]),
    }),
    message({
      role: "toolResult",
      toolCallId: releaseId,
      toolName: "bash",
      content: [{ type: "text", text: `released ${marker}` }],
      isError: false,
      timestamp: timestamp(offsets[2]),
    }),
    message({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: providerId,
          name: "provider_request",
          arguments: {
            method: "GET",
            path: gateEnvironment.DANO_PROVIDER_ACCEPTANCE_PATH,
          },
        },
      ],
      timestamp: timestamp(offsets[3]),
    }),
    message({
      role: "toolResult",
      toolCallId: providerId,
      toolName: "provider_request",
      content: [{ type: "text", text: JSON.stringify(details) }],
      details,
      isError: details.ok === false,
      timestamp: timestamp(offsets[4]),
    }),
  ];
}

function timestamp(offsetMs: number): number {
  return Date.parse("2026-08-12T00:00:00.000Z") + offsetMs;
}

function message(value: unknown) {
  return { type: "message", message: value };
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-provider-gate-"));
  roots.push(root);
  return root;
}

function runGate(
  mode: string,
  env: Record<string, string>,
  args: readonly string[] = [],
) {
  return spawnSync(process.execPath, [gateScript, mode, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...gateEnvironment, ...env },
    encoding: "utf8",
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function textOf(value: unknown): string {
  return JSON.stringify(value);
}
