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
import { createAskUserQuestionRuntime } from "../bridge/ask-user-question.js";
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

  it("installs a provider-independent Skill that holds each Turn with a public question", () => {
    const root = temporaryRoot();
    const agentDir = path.join(root, "agent");
    expect(runGate("install", { PI_CODING_AGENT_DIR: agentDir }).status).toBe(0);

    const installed = fs.readFileSync(
      path.join(agentDir, "skills/provider-broker-release-gate/SKILL.md"),
      "utf8",
    );
    expect(installed).toContain('path: "/acceptance/profile"');
    expect(installed).not.toMatch(/https?:\/\/|authorization|cookie|token/i);
    expect(installed.indexOf("`ask_user_question`")).toBeLessThan(
      installed.indexOf("`provider_request`"),
    );
    expect(installed).toContain('default: "continue"');
    expect(installed).not.toMatch(/`bash`|wait-for-release|releases\//i);
    expect(installed).not.toContain("{{");
    expect(
      fs.existsSync(
        path.join(
          agentDir,
          "skills/provider-broker-release-gate/wait-for-release.mjs",
        ),
      ),
    ).toBe(false);
    expect(runGate("release", { PI_CODING_AGENT_DIR: agentDir }).status).toBe(1);
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
        fauxToolCall("ask_user_question", {
          question: "Continue provider release gate gate-a-before?",
          inputType: "radio",
          options: [
            { id: "continue", label: "Continue" },
            { id: "stop", label: "Stop" },
          ],
          required: true,
          default: "continue",
        }, { id: "gate-question" }),
        { stopReason: "toolUse" },
      ),
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
    const questionRuntime = createAskUserQuestionRuntime();
    const { session } = await createAgentSession({
      cwd: workspace,
      agentDir,
      modelRuntime,
      model: modelProvider.getModel(),
      thinkingLevel: "off",
      noTools: "builtin",
      customTools: [questionRuntime.tool, credentialBroker.createTool("user-a")],
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
      const turn = session.prompt("/skill:provider-broker-release-gate gate-a-before");
      await waitUntil(() => questionRuntime.coordinator.state("gate-question") !== undefined);
      expect(providerFetch).not.toHaveBeenCalled();
      questionRuntime.coordinator.answer("gate-question", {
        cancelled: false,
        answer: "continue",
      });
      await turn;
      expect(providerFetch).toHaveBeenCalledOnce();
      const transcript = fs.readFileSync(session.sessionFile!, "utf8");
      expect(transcript).toContain("ask_user_question");
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
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.capture).toEqual({
      browserContexts: {
        a: "codex-in-app-browser",
        b: "chrome",
      },
      callbackMode: "single-shared-dano-callback",
      seam: "Dano HTTP/SSE and Pi transcript",
    });
    expect(evidence.observations.sequence).toMatchObject({
      aBeforeQuestionCallAt: null,
      aBeforeQuestionAnsweredAt: null,
      aAfterQuestionCallAt: null,
      logoutHttpStatus: null,
      aOldClientHttpStatus: null,
      bAfterLogoutStatus: null,
      aAfterQuestionAnsweredAt: null,
      bAfterQuestionCallAt: null,
      bAfterQuestionAnsweredAt: null,
    });
    expect(evidence.observations.sequence).not.toHaveProperty("aAfterWaitStartedAt");
    expect(evidence.observations.sequence).not.toHaveProperty("aAfterReleasedAt");
    expect(evidence.observations.questionAnswers).toEqual({
      aBeforeBrowser: null,
      aAfterBrowser: null,
      bAfterBrowser: null,
    });
    expect(raw).not.toMatch(
      /https?:\/\/|password|client.?secret|token|cookie|authorization/i,
    );
  });

  it("accepts only linked same-User, same-session, ordered public evidence", () => {
    const fixture = passingEvidence();
    expect(verifyFixture(fixture).status).toBe(0);
  });

  it("accepts the real Bridge slash invocation and safely coerced required flag", () => {
    const fixture = passingEvidence();
    const entries = fs
      .readFileSync(fixture.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    const firstUser = entries.find(entry =>
      textOf(entry).includes("<skill name=\\\"provider-broker-release-gate\\\""),
    );
    firstUser.message.content = `/skill:provider-broker-release-gate ${JSON.parse(
      fs.readFileSync(fixture.evidencePath, "utf8"),
    ).markers.aBefore}`;
    const firstQuestion = entries.find(entry =>
      textOf(entry).includes('"name":"ask_user_question"'),
    );
    firstQuestion.message.content[0].arguments.required = "true";
    entries.splice(
      entries.indexOf(firstQuestion),
      0,
      message({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "read-skill-fixture",
            name: "read",
            arguments: {
              path: `/tmp/skills/provider-broker-release-gate/SKILL.md`,
            },
          },
        ],
        timestamp: firstQuestion.message.timestamp - 1,
      }),
      message({
        role: "toolResult",
        toolCallId: "read-skill-fixture",
        toolName: "read",
        content: [{ type: "text", text: "skill" }],
        isError: false,
        timestamp: firstQuestion.message.timestamp - 1,
      }),
    );
    fs.writeFileSync(
      fixture.transcriptPath,
      `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`,
    );
    expect(verifyFixture(fixture).status).toBe(0);
  });

  it("rejects any extra tool outside the exact Skill loader", () => {
    const fixture = passingEvidence();
    const entries = fs
      .readFileSync(fixture.transcriptPath, "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    const firstQuestion = entries.find(entry =>
      textOf(entry).includes('"name":"ask_user_question"'),
    );
    entries.splice(
      entries.indexOf(firstQuestion),
      0,
      message({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "unexpected-command",
            name: "bash",
            arguments: { command: "true" },
          },
        ],
        timestamp: firstQuestion.message.timestamp - 1,
      }),
    );
    fs.writeFileSync(
      fixture.transcriptPath,
      `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`,
    );
    expect(verifyFixture(fixture).status).toBe(1);
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
    {
      label: "A-before question answered outside the Codex in-app Browser",
      mutate: (value: any) => {
        value.observations.questionAnswers.aBeforeBrowser = "chrome";
      },
    },
    {
      label: "held A-after question not answered from Chrome",
      mutate: (value: any) => {
        value.observations.questionAnswers.aAfterBrowser =
          "codex-in-app-browser";
      },
    },
    {
      label: "B-after question answered outside Chrome",
      mutate: (value: any) => {
        value.observations.questionAnswers.bAfterBrowser =
          "codex-in-app-browser";
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
      label: "logout after B answered the held question",
      mutate: (value: any) => {
        value.observations.sequence.logoutAt = "2026-08-12T00:00:05.500Z";
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
      label: "a non-canonical question",
      mutate: (entries: any[]) => {
        const call = entries.find(entry =>
          textOf(entry).includes('"name":"ask_user_question"'),
        );
        call.message.content[0].arguments.default = "stop";
      },
    },
    {
      label: "a question answer other than continue",
      mutate: (entries: any[]) => {
        const result = entries.find(entry =>
          textOf(entry).includes('"toolName":"ask_user_question"'),
        );
        result.message.details.answer = "stop";
      },
    },
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
  evidence.observations.questionAnswers = {
    aBeforeBrowser: "codex-in-app-browser",
    aAfterBrowser: "chrome",
    bAfterBrowser: "chrome",
  };
  evidence.observations.sequence = {
    aBeforeAcceptedAt: "2026-08-12T00:00:00.000Z",
    aBeforeQuestionCallAt: "2026-08-12T00:00:00.200Z",
    aBeforeQuestionAnsweredAt: "2026-08-12T00:00:00.500Z",
    aBeforeResultAt: "2026-08-12T00:00:01.000Z",
    aAfterAcceptedAt: "2026-08-12T00:00:02.000Z",
    aAfterQuestionCallAt: "2026-08-12T00:00:03.000Z",
    logoutAt: "2026-08-12T00:00:04.000Z",
    logoutHttpStatus: 200,
    aOldClientHttpStatus: 404,
    bAfterLogoutStatus: "authenticated",
    aAfterQuestionAnsweredAt: "2026-08-12T00:00:05.000Z",
    aAfterResultAt: "2026-08-12T00:00:06.000Z",
    bAfterAcceptedAt: "2026-08-12T00:00:07.000Z",
    bAfterQuestionCallAt: "2026-08-12T00:00:07.200Z",
    bAfterQuestionAnsweredAt: "2026-08-12T00:00:07.500Z",
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
  const questionId = `question-${marker}`;
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
          id: questionId,
          name: "ask_user_question",
          arguments: {
            question: `Continue provider release gate ${marker}?`,
            inputType: "radio",
            options: [
              { id: "continue", label: "Continue" },
              { id: "stop", label: "Stop" },
            ],
            required: true,
            default: "continue",
          },
        },
      ],
      timestamp: timestamp(offsets[1]),
    }),
    message({
      role: "toolResult",
      toolCallId: questionId,
      toolName: "ask_user_question",
      content: [{ type: "text", text: "answered" }],
      details: { status: "answered", answer: "continue" },
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

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
}
