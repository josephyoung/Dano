import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
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
const children: ChildProcess[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const gateScript = path.join(repositoryRoot, "scripts/check-provider-skill-release-gate.mjs");
const browserProducer = path.join(repositoryRoot, "scripts/provider-skill-release-gate-browser.mjs");
const gateEnvironment = { DANO_PROVIDER_ACCEPTANCE_PATH: "/acceptance/profile" };

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    if (child.exitCode === null) await once(child, "exit").catch(() => {});
  }
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("real provider Skill release gate", () => {
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
      fauxAssistantMessage([
        fauxToolCall("provider_request", {
          method: "GET",
          path: gateEnvironment.DANO_PROVIDER_ACCEPTANCE_PATH,
        }),
      ], { stopReason: "toolUse" }),
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
      const turn = session.prompt("/skill:provider-broker-release-gate gate-a-before");
      await waitUntil(() => questionRuntime.coordinator.state("gate-question") !== undefined);
      questionRuntime.coordinator.answer("gate-question", {
        cancelled: false,
        answer: "continue",
      });
      await turn;
      expect(providerFetch).toHaveBeenCalledOnce();
      expect(fs.readFileSync(session.sessionFile!, "utf8")).not.toContain("access-a");
    } finally {
      session.dispose();
    }
  });

  it("ships a browser producer for same-User shared-session logout sequencing", () => {
    const source = fs.readFileSync(browserProducer, "utf8");
    for (const seam of [
      "/api/auth/current",
      "/api/auth/logout",
      "/api/clients",
      "switch_session",
      "answer_question",
      "provider-broker-release-gate",
      "/preferences/theme",
    ]) expect(source).toContain(seam);
    expect(source).not.toMatch(/client.?secret|access.?token|refresh.?token|cookie/i);
  });

  it("emits LIVE PASS only after the active collector validates the Pi transcript", async () => {
    const fixture = await completeCapture({ sameUser: true });
    expect(fixture.output()).toContain("LIVE PASS:");
    const raw = fs.readFileSync(fixture.evidencePath, "utf8");
    const evidence = JSON.parse(raw);
    expect(evidence.recordPurpose).toBe("redacted-audit-only-not-live-proof");
    expect(raw).not.toMatch(/raw-client|shared-session\.jsonl|https?:\/\//i);
    expect(raw).not.toMatch(/password|cookie|authorization|client.?secret|access.?token|refresh.?token/i);

    const audit = runGate(
      "audit",
      { DANO_PROVIDER_GATE_SESSION: fixture.transcriptPath },
      [fixture.evidencePath],
    );
    expect(audit.status).toBe(0);
    expect(audit.stdout).toContain("AUDIT ONLY (NOT LIVE PASS)");
  });

  it("rejects different Users before writing a live audit record", async () => {
    const fixture = await completeCapture({ sameUser: false, expectFailure: true });
    expect(fixture.output()).not.toContain("LIVE PASS:");
    expect(fixture.error()).toContain("same canonical User");
    expect(fs.existsSync(fixture.evidencePath)).toBe(false);
  });

  it("refuses prepare and offline verify instead of reconstructing LIVE PASS", () => {
    const root = temporaryRoot();
    const evidencePath = path.join(root, "evidence.json");
    for (const mode of ["prepare", "verify"]) {
      const result = runGate(mode, {}, [evidencePath]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("cannot prove a live browser Skill run");
      expect(result.stdout).not.toContain("LIVE PASS");
    }
  });
});

async function completeCapture(options: {
  sameUser: boolean;
  expectFailure?: boolean;
}) {
  const root = temporaryRoot();
  const evidencePath = path.join(root, "evidence.json");
  const transcriptPath = path.join(root, "shared-session.jsonl");
  const capture = await startCapture(evidencePath);
  const config = await collectorJson(capture.urls.a, "/config");
  writeTranscript(transcriptPath, config.markers);
  await post(capture.urls.a, "/ready", {
    status: "authenticated",
    clientId: "raw-client-a",
    userId: "same-user",
    sessionPath: transcriptPath,
    preference: config.sharedPreference,
  });
  await post(capture.urls.b, "/ready", {
    status: "authenticated",
    clientId: "raw-client-b",
    userId: options.sameUser ? "same-user" : "different-user",
    sessionPath: transcriptPath,
    preference: config.sharedPreference,
  });
  await post(capture.urls.a, "/a-held", {});
  await post(capture.urls.a, "/a-logout", {
    logoutHttpStatus: 200,
    oldClientHttpStatus: 404,
  });
  await post(capture.urls.b, "/b-complete", { status: "authenticated" });
  const result = await capture.exit;
  if (options.expectFailure) expect(result.code).not.toBe(0);
  else expect(result.code).toBe(0);
  return { ...capture, evidencePath, transcriptPath };
}

async function startCapture(evidencePath: string) {
  const child = spawn(
    process.execPath,
    [gateScript, "capture", evidencePath, "--port", "0", "--timeout-ms", "10000"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        ...gateEnvironment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stdout!.on("data", chunk => { stdout += chunk; });
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const deadline = Date.now() + 5_000;
  while (!stdout.includes("SLOT_B=")) {
    if (child.exitCode !== null) throw new Error(stderr || stdout);
    if (Date.now() > deadline) throw new Error("capture did not start");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const url = (name: "A" | "B") => new URL(
    new RegExp(`SLOT_${name}=(http[^\\s]+)`).exec(stdout)![1],
  );
  return {
    urls: { a: url("A"), b: url("B") },
    output: () => stdout,
    error: () => stderr,
    exit: once(child, "exit").then(([code]) => ({ code })),
  };
}

function writeTranscript(transcriptPath: string, markers: Record<string, string>) {
  const now = Date.now();
  const offsets = [
    ...turnEntries(markers.aBefore, "success", [-10_000, -9_800, -9_600, -9_400, -9_200], now),
    ...turnEntries(markers.aAfter, "authentication_required", [-7_000, -6_000, 1_000, 1_200, 1_400], now),
    ...turnEntries(markers.bAfter, "success", [2_000, 2_200, 2_400, 2_600, 2_800], now),
  ];
  fs.writeFileSync(
    transcriptPath,
    `${offsets.map(value => JSON.stringify(value)).join("\n")}\n`,
  );
}

function turnEntries(marker: string, outcome: "success" | "authentication_required", offsets: number[], base: number) {
  const questionId = `question-${marker}`;
  const providerId = `provider-${marker}`;
  const details = outcome === "success"
    ? { ok: true, status: 200 }
    : { ok: false, error: { code: "authentication_required" } };
  const message = (value: unknown, offset: number) => ({
    type: "message",
    message: { ...(value as object), timestamp: base + offset },
  });
  return [
    message({ role: "user", content: `/skill:provider-broker-release-gate ${marker}` }, offsets[0]),
    message({ role: "assistant", content: [{ type: "toolCall", id: questionId, name: "ask_user_question", arguments: { question: `Continue provider release gate ${marker}?`, inputType: "radio", options: [{ id: "continue", label: "Continue" }, { id: "stop", label: "Stop" }], required: true, default: "continue" } }] }, offsets[1]),
    message({ role: "toolResult", toolCallId: questionId, toolName: "ask_user_question", content: [{ type: "text", text: "answered" }], details: { status: "answered", answer: "continue" }, isError: false }, offsets[2]),
    message({ role: "assistant", content: [{ type: "toolCall", id: providerId, name: "provider_request", arguments: { method: "GET", path: gateEnvironment.DANO_PROVIDER_ACCEPTANCE_PATH } }] }, offsets[3]),
    message({ role: "toolResult", toolCallId: providerId, toolName: "provider_request", content: [{ type: "text", text: JSON.stringify(details) }], details, isError: details.ok === false }, offsets[4]),
  ];
}

async function collectorJson(url: URL, route: string) {
  const response = await fetch(`${url.origin}${route}${url.search}`, {
    headers: { Origin: "http://localhost:5173" },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}

async function post(url: URL, route: string, body: unknown) {
  const response = await fetch(`${url.origin}${route}${url.search}`, {
    method: "POST",
    headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(202);
}

function temporaryRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dano-provider-gate-"));
  roots.push(root);
  return root;
}

function runGate(mode: string, env: Record<string, string>, args: string[] = []) {
  return spawnSync(process.execPath, [gateScript, mode, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...gateEnvironment, ...env },
    encoding: "utf8",
  });
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("condition was not reached");
}
