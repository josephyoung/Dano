#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN = /https?:\/\/|password|cookie|authorization|client.?secret|access.?token|refresh.?token|private.?key/i;
const SETTINGS = { idleTtlMs: 1_000, intervalMs: 50, clockAdvanceMs: 2_000 };
const TYPES = [
  "own", "own", "cross", "cross", "idle-sweep", "own",
  "turn-started", "turn-protected", "turn-released", "post-turn-sweep",
  "own", "authenticated-retained",
];
const FIELDS = {
  own: ["sequence", "type", "runId", "occurredAt", "slot", "authenticationStatus", "markerSha256", "transportBindingFingerprint", "ownerFingerprint", "clientFingerprint", "workspaceFingerprint", "uploadFingerprint", "sessionFingerprint", "transcriptContentSha256", "ownPreviewHttpStatus", "ownPreviewSha256"],
  cross: ["sequence", "type", "runId", "occurredAt", "slot", "sourceClientFingerprint", "targetClientFingerprint", "targetUploadFingerprint", "targetSessionFingerprint", "targetClientHttpStatus", "targetPreferenceHttpStatus", "targetPreviewHttpStatus", "targetSessionResult", "targetTranscriptResult", "targetWorkspaceResult", "targetFileResult"],
  "idle-sweep": ["sequence", "type", "runId", "occurredAt", "removedOwnerFingerprint", "removedWorkspaceFingerprint", "removedUploadFingerprint", "removedSessionFingerprint", "retainedOwnerFingerprint", "retainedWorkspaceFingerprint", "retainedUploadFingerprint", "retainedSessionFingerprint", "retainedCommandHttpStatus", "retainedPreviewHttpStatus", "retainedPreviewSha256"],
  "turn-started": ["sequence", "type", "runId", "occurredAt", "slot", "ownerFingerprint", "clientFingerprint", "workspaceFingerprint", "uploadFingerprint", "sessionFingerprint", "turnMarkerSha256", "promptHttpStatus", "providerRequestFingerprint"],
  "turn-protected": ["sequence", "type", "runId", "occurredAt", "ownerFingerprint", "workspaceFingerprint", "uploadFingerprint", "sessionFingerprint", "providerRequestFingerprint", "disconnectedClientHttpStatus", "retainedPreviewHttpStatus", "retainedPreviewSha256"],
  "turn-released": ["sequence", "type", "runId", "occurredAt", "providerRequestFingerprint", "providerResponseHttpStatus"],
  "post-turn-sweep": ["sequence", "type", "runId", "occurredAt", "removedOwnerFingerprint", "removedWorkspaceFingerprint", "removedUploadFingerprint", "removedSessionFingerprint", "retainedOwnerFingerprint", "retainedWorkspaceFingerprint", "retainedUploadFingerprint", "retainedSessionFingerprint"],
  "authenticated-retained": ["sequence", "type", "runId", "occurredAt", "ownerFingerprint", "workspaceFingerprint", "uploadFingerprint", "sessionFingerprint", "commandHttpStatus", "previewHttpStatus", "previewSha256"],
};

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const command = process.argv[2];
    const rawRunRoot = process.argv[3] ?? process.env.DANO_ANONYMOUS_GATE_RUN;
    if (typeof rawRunRoot !== "string" || rawRunRoot.trim() === "") throw new Error("run directory is required");
    const runRoot = resolve(rawRunRoot);
    if (!new Set(["prepare", "audit"]).has(command)) {
      throw new Error("usage: check-anonymous-release-gate.mjs <prepare|audit> <run-directory>");
    }
    command === "prepare" ? prepareRun(runRoot) : auditRun(runRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Anonymous release gate failed");
    process.exitCode = 1;
  }
}

export function prepareRun(runRoot) {
  mkdirSync(runRoot, { recursive: true });
  const evidencePath = join(runRoot, "evidence.json");
  const ledgerPath = join(runRoot, "ledger.ndjson");
  if (existsSync(evidencePath) || existsSync(ledgerPath)) throw new Error("run directory is already prepared");
  const evidence = {
    schemaVersion: 2,
    runId: randomUUID(),
    preparedAt: new Date().toISOString(),
    capture: {
      originMode: "single-dano-origin",
      seam: "Dano HTTP/SSE and visible acceptance UI",
    },
    cleanup: SETTINGS,
    markers: {
      a: marker("a"), b: marker("b"), a2: marker("a2"), authenticated: marker("authenticated"), turn: marker("turn"),
    },
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(ledgerPath, "", { flag: "wx", mode: 0o600 });
  mkdirSync(join(runRoot, "runtime"), { recursive: true });
  console.log(`prepared real Anonymous User release gate: ${runRoot}`);
}

export function auditRun(runRoot, { quiet = false } = {}) {
  const evidenceRaw = readFileSync(join(runRoot, "evidence.json"), "utf8");
  const ledgerRaw = readFileSync(join(runRoot, "ledger.ndjson"), "utf8");
  if (FORBIDDEN.test(evidenceRaw) || FORBIDDEN.test(ledgerRaw)) throw new Error("public evidence contains forbidden private data");
  const evidence = object(JSON.parse(evidenceRaw), "evidence");
  exact(evidence, ["schemaVersion", "runId", "preparedAt", "capture", "cleanup", "markers"], "evidence");
  exact(evidence.capture, ["originMode", "seam"], "capture");
  exact(evidence.cleanup, Object.keys(SETTINGS), "cleanup");
  exact(evidence.markers, ["a", "b", "a2", "authenticated", "turn"], "markers");
  equal(evidence.schemaVersion, 2, "schemaVersion");
  equal(evidence.capture?.originMode, "single-dano-origin", "origin mode");
  equal(evidence.capture?.seam, "Dano HTTP/SSE and visible acceptance UI", "public seam");
  for (const [key, value] of Object.entries(SETTINGS)) equal(evidence.cleanup?.[key], value, key);
  const records = ledgerRaw.split(/\r?\n/).filter(Boolean).map(line => object(JSON.parse(line), "ledger record"));
  if (records.length !== TYPES.length) throw new Error("ledger must contain complete live observations");
  let previous = Date.parse(evidence.preparedAt);
  records.forEach((record, index) => {
    equal(record.sequence, index + 1, "ledger sequence");
    equal(record.type, TYPES[index], "ledger type");
    equal(record.runId, evidence.runId, "ledger runId");
    exact(record, FIELDS[record.type], `ledger[${index}]`);
    const occurred = date(record.occurredAt, "occurredAt");
    if (occurred <= previous) throw new Error("ledger timeline must be strictly monotonic");
    previous = occurred;
  });
  verifyRelations(evidence, records);
  verifyFinalRuntime(join(runRoot, "runtime"), records, evidence);
  if (!quiet) console.log("Anonymous User release gate audit is internally consistent");
}

function verifyRelations(evidence, r) {
  const [a, b, crossA, crossB, idle, a2, started, protectedTurn, released, postTurn, authenticated, authRetained] = r;
  own(a, "a", "anonymous", evidence.markers.a);
  own(b, "b", "anonymous", evidence.markers.b);
  if (a.transportBindingFingerprint === b.transportBindingFingerprint) throw new Error("A and B must use distinct live Cookie bindings");
  if (a.ownerFingerprint === b.ownerFingerprint) throw new Error("A and B must resolve distinct Anonymous Users");
  cross(crossA, a, b, "a"); cross(crossB, b, a, "b");
  relation(idle.removedOwnerFingerprint, a.ownerFingerprint, "idle removed owner");
  relation(idle.removedWorkspaceFingerprint, a.workspaceFingerprint, "idle removed workspace");
  relation(idle.removedUploadFingerprint, a.uploadFingerprint, "idle removed upload");
  relation(idle.removedSessionFingerprint, a.sessionFingerprint, "idle removed session");
  retained(idle, b);
  own(a2, "a2", "anonymous", evidence.markers.a2);
  relation(started.ownerFingerprint, a2.ownerFingerprint, "turn owner");
  relation(started.clientFingerprint, a2.clientFingerprint, "turn client");
  relation(started.workspaceFingerprint, a2.workspaceFingerprint, "turn workspace");
  relation(started.uploadFingerprint, a2.uploadFingerprint, "turn upload");
  relation(started.sessionFingerprint, a2.sessionFingerprint, "turn session");
  relation(started.turnMarkerSha256, hash(evidence.markers.turn), "turn marker");
  equal(started.promptHttpStatus, 202, "turn prompt status"); hashField(started.providerRequestFingerprint, "provider request");
  for (const field of ["ownerFingerprint", "workspaceFingerprint", "uploadFingerprint", "sessionFingerprint", "providerRequestFingerprint"]) relation(protectedTurn[field], started[field], `protected ${field}`);
  equal(protectedTurn.disconnectedClientHttpStatus, 409, "disconnected turn client status");
  equal(protectedTurn.retainedPreviewHttpStatus, 200, "protected preview status");
  relation(protectedTurn.retainedPreviewSha256, a2.markerSha256, "protected preview");
  relation(released.providerRequestFingerprint, started.providerRequestFingerprint, "released provider request");
  equal(released.providerResponseHttpStatus, 200, "provider response status");
  for (const field of ["Owner", "Workspace", "Upload", "Session"]) relation(postTurn[`removed${field}Fingerprint`], a2[`${field.toLowerCase()}Fingerprint`], `post-turn removed ${field}`);
  relation(postTurn.retainedOwnerFingerprint, b.ownerFingerprint, "post-turn retained owner");
  relation(postTurn.retainedWorkspaceFingerprint, b.workspaceFingerprint, "post-turn retained workspace");
  relation(postTurn.retainedUploadFingerprint, b.uploadFingerprint, "post-turn retained upload");
  relation(postTurn.retainedSessionFingerprint, b.sessionFingerprint, "post-turn retained session");
  own(authenticated, "authenticated", "authenticated", evidence.markers.authenticated);
  relation(authRetained.ownerFingerprint, authenticated.ownerFingerprint, "authenticated owner retained");
  relation(authRetained.workspaceFingerprint, authenticated.workspaceFingerprint, "authenticated workspace retained");
  relation(authRetained.uploadFingerprint, authenticated.uploadFingerprint, "authenticated upload retained");
  relation(authRetained.sessionFingerprint, authenticated.sessionFingerprint, "authenticated session retained");
  equal(authRetained.commandHttpStatus, 202, "authenticated command status");
  equal(authRetained.previewHttpStatus, 200, "authenticated preview status");
  relation(authRetained.previewSha256, authenticated.markerSha256, "authenticated preview");
}

function own(record, slot, authenticationStatus, markerValue) {
  equal(record.slot, slot, `${slot} slot`); equal(record.authenticationStatus, authenticationStatus, `${slot} authentication`);
  relation(record.markerSha256, hash(markerValue), `${slot} marker`);
  for (const field of ["transportBindingFingerprint", "ownerFingerprint", "clientFingerprint", "workspaceFingerprint", "uploadFingerprint", "sessionFingerprint", "transcriptContentSha256"]) hashField(record[field], `${slot} ${field}`);
  equal(record.ownPreviewHttpStatus, 200, `${slot} preview status`); relation(record.ownPreviewSha256, record.markerSha256, `${slot} preview content`);
}

function cross(record, source, target, slot) {
  equal(record.slot, slot, `${slot} cross slot`); relation(record.sourceClientFingerprint, source.clientFingerprint, "cross source");
  relation(record.targetClientFingerprint, target.clientFingerprint, "cross target client"); relation(record.targetUploadFingerprint, target.uploadFingerprint, "cross target upload");
  relation(record.targetSessionFingerprint, target.sessionFingerprint, "cross target session");
  equal(record.targetClientHttpStatus, 403, "cross client status"); equal(record.targetPreferenceHttpStatus, 403, "cross preference status"); equal(record.targetPreviewHttpStatus, 403, "cross preview status");
  equal(record.targetSessionResult, "rejected", "cross session result"); equal(record.targetTranscriptResult, "absent", "cross transcript result"); equal(record.targetWorkspaceResult, "rejected", "cross workspace result"); equal(record.targetFileResult, "rejected", "cross file result");
}

function retained(record, owner) {
  relation(record.retainedOwnerFingerprint, owner.ownerFingerprint, "retained owner"); relation(record.retainedWorkspaceFingerprint, owner.workspaceFingerprint, "retained workspace"); relation(record.retainedUploadFingerprint, owner.uploadFingerprint, "retained upload");
  relation(record.retainedSessionFingerprint, owner.sessionFingerprint, "retained session");
  equal(record.retainedCommandHttpStatus, 202, "retained command status"); equal(record.retainedPreviewHttpStatus, 200, "retained preview status"); relation(record.retainedPreviewSha256, owner.markerSha256, "retained preview");
}

function verifyFinalRuntime(runtimeRoot, records, evidence) {
  const inventory = runtimeInventory(runtimeRoot);
  const [a, b, , , , a2, , , , , authenticated] = records;
  for (const removed of [a, a2]) {
    absent(inventory.owners, removed.ownerFingerprint, "removed Anonymous User still exists"); absent(inventory.workspaces, removed.workspaceFingerprint, "removed workspace still exists"); absent(inventory.uploads, removed.uploadFingerprint, "removed upload still exists"); absent(inventory.sessions, removed.sessionFingerprint, "removed session or transcript still exists");
  }
  for (const kept of [b, authenticated]) {
    present(inventory.owners, kept.ownerFingerprint, `${kept.slot} retained User is missing`); present(inventory.workspaces, kept.workspaceFingerprint, `${kept.slot} retained workspace is missing`); present(inventory.uploads, kept.uploadFingerprint, `${kept.slot} retained upload is missing`); present(inventory.sessions, kept.sessionFingerprint, `${kept.slot} retained session is missing`);
    relation(inventory.uploadContentHashes.get(kept.uploadFingerprint), kept.markerSha256, "retained upload content");
    if (!inventory.transcripts.get(kept.sessionFingerprint)?.includes(evidence.markers[kept.slot])) throw new Error(`${kept.slot} retained transcript marker is missing`);
  }
}

function runtimeInventory(root) {
  const owners = new Set(), workspaces = new Set(), uploads = new Set(), sessions = new Set(), transcripts = new Map(), uploadContentHashes = new Map();
  for (const directory of directories(join(root, "users"))) {
    const match = /\/users\/([^/]+)$/.exec(directory); if (match) owners.add(hash(match[1]));
    if (directory.endsWith("/workspaces/default")) workspaces.add(hash(realpathSync(directory)));
  }
  for (const file of files(join(root, "uploads", "records"))) {
    const stored = JSON.parse(readFileSync(file, "utf8")); const upload = stored.upload ?? stored;
    if (typeof upload.id === "string") {
      const fingerprint = hash(upload.id);
      uploads.add(fingerprint);
      if (typeof upload.path === "string" && existsSync(upload.path)) uploadContentHashes.set(fingerprint, hash(readFileSync(upload.path)));
    }
  }
  for (const file of files(root).filter(file => file.endsWith(".jsonl"))) {
    const fingerprint = hash(realpathSync(file)); sessions.add(fingerprint); transcripts.set(fingerprint, readFileSync(file, "utf8"));
  }
  return { owners, workspaces, uploads, sessions, transcripts, uploadContentHashes };
}


function files(root) { if (!existsSync(root)) return []; return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(root, entry.name)) : entry.isFile() ? [join(root, entry.name)] : []); }
function directories(root) { if (!existsSync(root)) return []; return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? [join(root, entry.name), ...directories(join(root, entry.name))] : []); }
function marker(slot) { return `dano424-anonymous-${slot}-${randomBytes(12).toString("hex")}`; }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function hashField(value, name) { if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${name} is invalid`); }
function relation(actual, expected, name) { if (actual !== expected) throw new Error(`${name} does not match`); }
function equal(actual, expected, name) { if (actual !== expected) throw new Error(`${name} must equal ${JSON.stringify(expected)}`); }
function date(value, name) { const parsed = typeof value === "string" ? Date.parse(value) : NaN; if (!Number.isFinite(parsed)) throw new Error(`${name} is invalid`); return parsed; }
function object(value, name) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value; }
function exact(value, fields, name) { object(value, name); if (Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) throw new Error(`${name} has unexpected fields`); }
function present(set, value, message) { if (!set.has(value)) throw new Error(message); }
function absent(set, value, message) { if (set.has(value)) throw new Error(message); }
