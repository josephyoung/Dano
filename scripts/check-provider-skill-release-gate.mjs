#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixtureDir = join(root, "scripts/fixtures/provider-broker-release-gate");
const skillName = "provider-broker-release-gate";
const mode = process.argv[2];
const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN_EVIDENCE =
  /https?:\/\/|password|client.?secret|access.?token|refresh.?token|cookie|authorization|login.?session|private.?payload/i;

try {
  if (mode === "install") installSkill();
  else if (mode === "remove") removeSkill();
  else if (mode === "prepare") prepareEvidence(requiredArgument(3));
  else if (mode === "verify") verifyGate(requiredArgument(3));
  else {
    throw new Error(
      "usage: check-provider-skill-release-gate.mjs <install|remove|prepare|verify> [evidence.json]",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "release gate failed");
  process.exitCode = 1;
}

function installSkill() {
  const agentDir = requiredEnvironment("PI_CODING_AGENT_DIR");
  const providerPath = configuredProviderPath();
  const targetDir = join(agentDir, "skills", skillName);
  const targetPath = join(targetDir, "SKILL.md");
  const rendered = readFileSync(join(fixtureDir, "SKILL.md"), "utf8")
    .replace("{{PROVIDER_REQUEST_PATH}}", escapeYamlString(providerPath));
  if (rendered.includes("{{")) {
    throw new Error("provider Skill fixture contains an unresolved value");
  }

  mkdirSync(targetDir, { recursive: true });
  const stagingPath = join(targetDir, `.SKILL.md.${process.pid}.tmp`);
  writeFileSync(stagingPath, rendered, { mode: 0o600 });
  renameSync(stagingPath, targetPath);
  console.log(`installed ${skillName}`);
}

function removeSkill() {
  const agentDir = requiredEnvironment("PI_CODING_AGENT_DIR");
  rmSync(join(agentDir, "skills", skillName), {
    recursive: true,
    force: true,
  });
  console.log(`removed ${skillName}`);
}

function prepareEvidence(evidencePath) {
  if (existsSync(evidencePath)) {
    throw new Error("provider Skill evidence file already exists");
  }
  const evidence = {
    schemaVersion: 2,
    runId: randomUUID(),
    preparedAt: new Date().toISOString(),
    completedAt: null,
    capture: {
      browserContexts: {
        a: "codex-in-app-browser",
        b: "chrome",
      },
      callbackMode: "single-shared-dano-callback",
      seam: "Dano HTTP/SSE and Pi transcript",
    },
    markers: {
      aBefore: marker("a-before"),
      aAfter: marker("a-after"),
      bAfter: marker("b-after"),
      sharedPreference: "yellow",
    },
    observations: {
      identity: {
        aStatus: null,
        bStatus: null,
        aClientFingerprint: null,
        aAfterClientFingerprint: null,
        bClientFingerprint: null,
        aUserIdFingerprint: null,
        bUserIdFingerprint: null,
        aPreference: null,
        bPreference: null,
      },
      sharedRuntime: {
        aSessionFingerprint: null,
        bSessionFingerprint: null,
        bSwitchStatus: null,
      },
      questionAnswers: {
        aBeforeBrowser: null,
        aAfterBrowser: null,
        bAfterBrowser: null,
      },
      sequence: emptySequence(),
    },
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  console.log(`prepared provider Skill evidence: ${evidencePath}`);
}

function emptySequence() {
  return {
    aBeforeAcceptedAt: null,
    aBeforeQuestionCallAt: null,
    aBeforeQuestionAnsweredAt: null,
    aBeforeResultAt: null,
    aAfterAcceptedAt: null,
    aAfterQuestionCallAt: null,
    logoutAt: null,
    logoutHttpStatus: null,
    aOldClientHttpStatus: null,
    bAfterLogoutStatus: null,
    aAfterQuestionAnsweredAt: null,
    aAfterResultAt: null,
    bAfterAcceptedAt: null,
    bAfterQuestionCallAt: null,
    bAfterQuestionAnsweredAt: null,
    bAfterResultAt: null,
  };
}

function verifyGate(evidencePath) {
  const raw = readFileSync(evidencePath, "utf8");
  const evidence = JSON.parse(raw);
  const errors = verifyEvidence(
    evidence,
    raw,
    configuredProviderPath(),
    requiredEnvironment("DANO_PROVIDER_GATE_SESSION"),
  );
  if (errors.length > 0) throw new Error(errors.join("\n"));
  console.log("session A before logout: success");
  console.log("session A after logout: authentication_required");
  console.log("session B after logout: success");
  console.log("real provider Skill/Broker evidence contract passed");
}

function verifyEvidence(value, raw, providerPath, sessionPath) {
  const errors = [];
  if (!record(value)) return ["evidence must be a JSON object"];
  if (FORBIDDEN_EVIDENCE.test(raw)) {
    errors.push("evidence contains forbidden provider or credential data");
  }
  equal(value.schemaVersion, 2, "schemaVersion", errors);
  match(value.runId, /^[0-9a-f-]{36}$/i, "runId", errors);
  isoDate(value.preparedAt, "preparedAt", errors);
  isoDate(value.completedAt, "completedAt", errors);
  equal(
    value.capture?.browserContexts?.a,
    "codex-in-app-browser",
    "capture.browserContexts.a",
    errors,
  );
  equal(
    value.capture?.browserContexts?.b,
    "chrome",
    "capture.browserContexts.b",
    errors,
  );
  equal(
    value.capture?.callbackMode,
    "single-shared-dano-callback",
    "capture.callbackMode",
    errors,
  );
  equal(
    value.capture?.seam,
    "Dano HTTP/SSE and Pi transcript",
    "capture.seam",
    errors,
  );

  const markers = value.markers;
  for (const field of ["aBefore", "aAfter", "bAfter"]) {
    if (!validMarker(markers?.[field])) errors.push(`markers.${field} is invalid`);
  }
  if (new Set([markers?.aBefore, markers?.aAfter, markers?.bAfter]).size !== 3) {
    errors.push("Skill markers must be distinct");
  }
  match(
    markers?.sharedPreference,
    /^yellow$/,
    "markers.sharedPreference",
    errors,
  );

  const identity = value.observations?.identity;
  equal(identity?.aStatus, "authenticated", "identity.aStatus", errors);
  equal(identity?.bStatus, "authenticated", "identity.bStatus", errors);
  match(identity?.aClientFingerprint, SHA256, "identity.aClientFingerprint", errors);
  match(
    identity?.aAfterClientFingerprint,
    SHA256,
    "identity.aAfterClientFingerprint",
    errors,
  );
  match(identity?.bClientFingerprint, SHA256, "identity.bClientFingerprint", errors);
  equal(
    identity?.aClientFingerprint,
    identity?.aAfterClientFingerprint,
    "A-before and A-after must originate from the same Browser Client",
    errors,
  );
  if (identity?.aClientFingerprint === identity?.bClientFingerprint) {
    errors.push("A and B must use different Browser Clients");
  }
  match(
    identity?.aUserIdFingerprint,
    SHA256,
    "identity.aUserIdFingerprint",
    errors,
  );
  match(
    identity?.bUserIdFingerprint,
    SHA256,
    "identity.bUserIdFingerprint",
    errors,
  );
  equal(
    identity?.aUserIdFingerprint,
    identity?.bUserIdFingerprint,
    "A and B must resolve to the same canonical User ID fingerprint",
    errors,
  );
  equal(identity?.aPreference, markers?.sharedPreference, "identity.aPreference", errors);
  equal(identity?.bPreference, markers?.sharedPreference, "identity.bPreference", errors);

  const runtime = value.observations?.sharedRuntime;
  match(runtime?.aSessionFingerprint, SHA256, "sharedRuntime.aSessionFingerprint", errors);
  match(runtime?.bSessionFingerprint, SHA256, "sharedRuntime.bSessionFingerprint", errors);
  equal(
    runtime?.aSessionFingerprint,
    runtime?.bSessionFingerprint,
    "A and B must observe the same Agent Session fingerprint",
    errors,
  );
  equal(runtime?.bSwitchStatus, "succeeded", "sharedRuntime.bSwitchStatus", errors);

  const questionAnswers = value.observations?.questionAnswers;
  equal(
    questionAnswers?.aBeforeBrowser,
    "codex-in-app-browser",
    "questionAnswers.aBeforeBrowser",
    errors,
  );
  equal(
    questionAnswers?.aAfterBrowser,
    "chrome",
    "questionAnswers.aAfterBrowser",
    errors,
  );
  equal(
    questionAnswers?.bAfterBrowser,
    "chrome",
    "questionAnswers.bAfterBrowser",
    errors,
  );

  verifySequence(value.observations?.sequence, errors);
  equal(
    sha256(resolve(sessionPath)),
    runtime?.aSessionFingerprint,
    "DANO_PROVIDER_GATE_SESSION must be the shared Agent Session",
    errors,
  );
  const phaseProofs = [];
  for (const [field, markerField, expected] of [
    ["aBefore", "aBefore", "success"],
    ["aAfter", "aAfter", "authentication_required"],
    ["bAfter", "bAfter", "success"],
  ]) {
    const proof = verifyTranscript(
      sessionPath,
      markers?.[markerField],
      expected,
      providerPath,
    );
    if (proof.outcome !== expected) {
      errors.push(`${field} transcript phase produced ${proof.outcome}`);
    } else {
      phaseProofs.push({ field, proof });
    }
  }
  verifyTranscriptTimeline(phaseProofs, value.observations?.sequence, errors);
  return errors;
}

function verifyTranscriptTimeline(phases, sequence, errors) {
  if (phases.length !== 3) return;
  const [aBefore, aAfter, bAfter] = phases.map(phase => phase.proof);
  if (!(aBefore.startIndex < aAfter.startIndex && aAfter.startIndex < bAfter.startIndex)) {
    errors.push("transcript phases must be ordered A-before, held A-after, B-after");
  }
  for (const [actual, field] of [
    [aBefore.userAt, "aBeforeAcceptedAt"],
    [aBefore.questionCallAt, "aBeforeQuestionCallAt"],
    [aBefore.questionResultAt, "aBeforeQuestionAnsweredAt"],
    [aBefore.providerResultAt, "aBeforeResultAt"],
    [aAfter.userAt, "aAfterAcceptedAt"],
    [aAfter.questionCallAt, "aAfterQuestionCallAt"],
    [aAfter.questionResultAt, "aAfterQuestionAnsweredAt"],
    [aAfter.providerResultAt, "aAfterResultAt"],
    [bAfter.userAt, "bAfterAcceptedAt"],
    [bAfter.questionCallAt, "bAfterQuestionCallAt"],
    [bAfter.questionResultAt, "bAfterQuestionAnsweredAt"],
    [bAfter.providerResultAt, "bAfterResultAt"],
  ]) {
    equal(actual, sequence?.[field], `sequence.${field} must match Pi transcript`, errors);
  }
  const logout = Date.parse(sequence?.logoutAt ?? "");
  const presented = Date.parse(aAfter.questionCallAt);
  const answered = Date.parse(aAfter.questionResultAt);
  if (!(presented < logout && logout < answered)) {
    errors.push("logoutAt must be after A's question call and before B answers it");
  }
}

function verifySequence(sequence, errors) {
  const timeFields = [
    "aBeforeAcceptedAt",
    "aBeforeQuestionCallAt",
    "aBeforeQuestionAnsweredAt",
    "aBeforeResultAt",
    "aAfterAcceptedAt",
    "aAfterQuestionCallAt",
    "logoutAt",
    "aAfterQuestionAnsweredAt",
    "aAfterResultAt",
    "bAfterAcceptedAt",
    "bAfterQuestionCallAt",
    "bAfterQuestionAnsweredAt",
    "bAfterResultAt",
  ];
  for (const field of timeFields) isoDate(sequence?.[field], `sequence.${field}`, errors);
  const timestamps = timeFields.map(field => Date.parse(sequence?.[field] ?? ""));
  if (
    timestamps.every(Number.isFinite) &&
    timestamps.some((value, index) => index > 0 && value <= timestamps[index - 1])
  ) {
    errors.push("release-gate timestamps must be monotonic");
  }
  equal(sequence?.logoutHttpStatus, 200, "sequence.logoutHttpStatus", errors);
  equal(sequence?.aOldClientHttpStatus, 404, "sequence.aOldClientHttpStatus", errors);
  equal(
    sequence?.bAfterLogoutStatus,
    "authenticated",
    "sequence.bAfterLogoutStatus",
    errors,
  );
}

function verifyTranscript(sessionPath, markerValue, expected, providerPath) {
  const files = transcriptFiles(sessionPath);
  if (files.length !== 1) return { outcome: "invalid" };
  for (const file of files) {
    const entries = readEntries(file);
    const start = entries.findIndex(entry => {
      const message = messageOf(entry);
      const text = textOf(message?.content);
      return (
        message?.role === "user" &&
        text.includes(markerValue) &&
        (text.includes(`skill name="${skillName}"`) ||
          text.includes(`/skill:${skillName}`))
      );
    });
    if (start < 0) continue;
    const nextUser = entries.findIndex(
      (entry, index) => index > start && messageOf(entry)?.role === "user",
    );
    const entriesForTurn = entries.slice(
      start + 1,
      nextUser < 0 ? entries.length : nextUser,
    );
    const execution = turnExecution(entriesForTurn, markerValue, providerPath);
    if (!execution) return { outcome: "invalid" };
    const proof = {
      outcome: providerOutcome(execution.providerResult),
      startIndex: start,
      userAt: isoTimestamp(messageOf(entries[start])),
      questionCallAt: execution.questionCallAt,
      questionResultAt: execution.questionResultAt,
      providerResultAt: execution.providerResultAt,
    };
    return Object.values(proof).some(value => value === null)
      ? { outcome: "invalid" }
      : proof;
  }
  return { outcome: "missing_skill_invocation" };
}

function turnExecution(entries, markerValue, providerPath) {
  const calls = entries.flatMap((entry, index) =>
    toolCalls(messageOf(entry)).map(call => ({ call, index })),
  );
  const allowedCalls = calls.filter(({ call }) =>
    call.name === "read"
      ? typeof (call.arguments ?? call.args)?.path === "string" &&
        (call.arguments ?? call.args).path.endsWith(
          `/skills/${skillName}/SKILL.md`,
        )
      : call.name === "ask_user_question" || call.name === "provider_request",
  );
  if (allowedCalls.length !== calls.length) return null;
  const relevantCalls = calls.filter(
    ({ call }) =>
      call.name === "ask_user_question" || call.name === "provider_request",
  );
  if (
    relevantCalls.length !== 2 ||
    relevantCalls[0]?.call.name !== "ask_user_question" ||
    relevantCalls[1]?.call.name !== "provider_request"
  ) return null;
  const questionCall = relevantCalls[0].call;
  const questionArguments = questionCall.arguments ?? questionCall.args;
  if (
    !record(questionArguments) ||
    Object.keys(questionArguments).length !== 5 ||
    questionArguments.question !== `Continue provider release gate ${markerValue}?` ||
    questionArguments.inputType !== "radio" ||
    !booleanLike(questionArguments.required, true) ||
    questionArguments.default !== "continue" ||
    JSON.stringify(questionArguments.options) !==
      JSON.stringify([
        { id: "continue", label: "Continue" },
        { id: "stop", label: "Stop" },
      ])
  ) return null;
  const providerArguments =
    relevantCalls[1].call.arguments ?? relevantCalls[1].call.args;
  if (
    !record(providerArguments) ||
    Object.keys(providerArguments).length !== 2 ||
    providerArguments.method !== "GET" ||
    providerArguments.path !== providerPath
  ) return null;

  const questionResult = matchingResult(
    entries,
    questionCall.id,
    "ask_user_question",
  );
  const providerResult = matchingResult(
    entries,
    relevantCalls[1].call.id,
    "provider_request",
  );
  if (
    !questionResult ||
    questionResult.index <= relevantCalls[0].index ||
    questionResult.index >= relevantCalls[1].index ||
    questionResult.message.isError === true ||
    questionResult.message.details?.status !== "answered" ||
    questionResult.message.details?.answer !== "continue" ||
    !providerResult ||
    providerResult.index <= relevantCalls[1].index
  ) return null;
  return {
    providerResult: providerResult.message,
    questionCallAt: isoTimestamp(messageOf(entries[relevantCalls[0].index])),
    questionResultAt: isoTimestamp(questionResult.message),
    providerResultAt: isoTimestamp(providerResult.message),
  };
}

function isoTimestamp(message) {
  const value = message?.timestamp;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function transcriptFiles(sessionPath) {
  if (!existsSync(sessionPath)) return [];
  return !statSync(sessionPath).isDirectory() && sessionPath.endsWith(".jsonl")
    ? [sessionPath]
    : [];
}

function readEntries(file) {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function toolCalls(message) {
  if (!message) return [];
  if (message.type === "toolCall") return [message];
  if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content.filter(block => block?.type === "toolCall");
}

function matchingResult(entries, callId, toolName) {
  if (typeof callId !== "string") return null;
  const matches = [];
  for (const [index, entry] of entries.entries()) {
    const message = messageOf(entry);
    if (
      message?.role === "toolResult" &&
      message.toolCallId === callId &&
      message.toolName === toolName
    ) matches.push({ message, index });
  }
  return matches.length === 1 ? matches[0] : null;
}

function providerOutcome(message) {
  const details = record(message.details)
    ? message.details
    : parseObject(textOf(message.content));
  if (
    details?.ok === true &&
    Number.isInteger(details.status) &&
    details.status >= 200 &&
    details.status < 300
  ) return "success";
  return details?.ok === false &&
    details.error?.code === "authentication_required"
    ? "authentication_required"
    : "unexpected_result";
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return record(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function messageOf(entry) {
  return entry?.type === "message" && entry.message ? entry.message : entry;
}

function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (record(value)) return Object.values(value).map(textOf).join("\n");
  return "";
}

function configuredProviderPath() {
  return relativeProviderPath(requiredEnvironment("DANO_PROVIDER_ACCEPTANCE_PATH"));
}

function relativeProviderPath(value) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error("DANO_PROVIDER_ACCEPTANCE_PATH must be a relative provider path");
  }
  const parsed = new URL(value, "https://provider.invalid");
  if (parsed.origin !== "https://provider.invalid") {
    throw new Error("DANO_PROVIDER_ACCEPTANCE_PATH must stay on the provider origin");
  }
  return `${parsed.pathname}${parsed.search}`;
}

function marker(phase) {
  return `dano424-${phase}-${randomBytes(10).toString("hex")}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validMarker(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

function record(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function booleanLike(value, expected) {
  if (value === expected) return true;
  if (typeof value !== "string") return false;
  return value.trim().toLowerCase() === String(expected);
}

function equal(actual, expected, path, errors) {
  if (actual !== expected) errors.push(`${path} must equal ${JSON.stringify(expected)}`);
}

function match(value, pattern, path, errors) {
  if (typeof value !== "string" || !pattern.test(value)) {
    errors.push(`${path} has an invalid value`);
  }
}

function isoDate(value, path, errors) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${path} must be an ISO date`);
  }
}

function escapeYamlString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function requiredArgument(index) {
  const value = process.argv[index]?.trim();
  if (!value) throw new Error("evidence path is required");
  return value;
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
