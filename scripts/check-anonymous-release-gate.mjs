#!/usr/bin/env node
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN = /https?:\/\/|password|cookie|authorization|client.?secret|access.?token|refresh.?token|private.?key/i;
const SETTINGS = { idleTtlMs: 1_000, intervalMs: 50, clockAdvanceMs: 2_000 };
const TYPES = [
  "own", "own", "cross", "cross", "idle-sweep", "own",
  "turn-started", "turn-protected", "turn-released", "post-turn-sweep",
  "own", "authenticated-retained",
];
const FIELDS = {
  own: ["sequence", "type", "runId", "occurredAt", "slot", "authenticationStatus", "markerSha256", "ownerFingerprint", "clientFingerprint", "workspaceFingerprint", "uploadFingerprint", "ownPreviewHttpStatus", "ownPreviewSha256", "signature"],
  cross: ["sequence", "type", "runId", "occurredAt", "slot", "sourceClientFingerprint", "targetClientFingerprint", "targetUploadFingerprint", "targetClientHttpStatus", "targetPreferenceHttpStatus", "targetPreviewHttpStatus", "signature"],
  "idle-sweep": ["sequence", "type", "runId", "occurredAt", "removedOwnerFingerprint", "removedWorkspaceFingerprint", "removedUploadFingerprint", "retainedOwnerFingerprint", "retainedWorkspaceFingerprint", "retainedUploadFingerprint", "retainedCommandHttpStatus", "retainedPreviewHttpStatus", "retainedPreviewSha256", "signature"],
  "turn-started": ["sequence", "type", "runId", "occurredAt", "slot", "ownerFingerprint", "clientFingerprint", "workspaceFingerprint", "uploadFingerprint", "turnMarkerSha256", "promptHttpStatus", "providerRequestFingerprint", "signature"],
  "turn-protected": ["sequence", "type", "runId", "occurredAt", "ownerFingerprint", "workspaceFingerprint", "uploadFingerprint", "providerRequestFingerprint", "disconnectedClientHttpStatus", "retainedPreviewHttpStatus", "retainedPreviewSha256", "signature"],
  "turn-released": ["sequence", "type", "runId", "occurredAt", "providerRequestFingerprint", "providerResponseHttpStatus", "signature"],
  "post-turn-sweep": ["sequence", "type", "runId", "occurredAt", "removedOwnerFingerprint", "removedWorkspaceFingerprint", "removedUploadFingerprint", "retainedOwnerFingerprint", "retainedWorkspaceFingerprint", "retainedUploadFingerprint", "signature"],
  "authenticated-retained": ["sequence", "type", "runId", "occurredAt", "ownerFingerprint", "workspaceFingerprint", "uploadFingerprint", "commandHttpStatus", "previewHttpStatus", "previewSha256", "signature"],
};

try {
  const command = process.argv[2];
  const runRoot = resolve(process.argv[3] ?? process.env.DANO_ANONYMOUS_GATE_RUN ?? "");
  if (!runRoot || !new Set(["prepare", "verify"]).has(command)) {
    throw new Error("usage: check-anonymous-release-gate.mjs <prepare|verify> <run-directory>");
  }
  command === "prepare" ? prepare(runRoot) : verify(runRoot);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Anonymous release gate failed");
  process.exitCode = 1;
}

function prepare(runRoot) {
  mkdirSync(runRoot, { recursive: true });
  const evidencePath = join(runRoot, "evidence.json");
  const ledgerPath = join(runRoot, "ledger.ndjson");
  if (existsSync(evidencePath) || existsSync(ledgerPath)) throw new Error("run directory is already prepared");
  const evidence = {
    schemaVersion: 2,
    runId: randomUUID(),
    preparedAt: new Date().toISOString(),
    capture: {
      browserContexts: { a: "codex-in-app-browser", b: "chrome" },
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

function verify(runRoot) {
  const evidenceRaw = readFileSync(join(runRoot, "evidence.json"), "utf8");
  const ledgerRaw = readFileSync(join(runRoot, "ledger.ndjson"), "utf8");
  if (FORBIDDEN.test(evidenceRaw) || FORBIDDEN.test(ledgerRaw)) throw new Error("public evidence contains forbidden private data");
  const evidence = object(JSON.parse(evidenceRaw), "evidence");
  exact(evidence, ["schemaVersion", "runId", "preparedAt", "capture", "cleanup", "markers", "attestation"], "evidence");
  exact(evidence.capture, ["browserContexts", "originMode", "seam"], "capture");
  exact(evidence.capture.browserContexts, ["a", "b"], "browserContexts");
  exact(evidence.cleanup, Object.keys(SETTINGS), "cleanup");
  exact(evidence.markers, ["a", "b", "a2", "authenticated", "turn"], "markers");
  exact(evidence.attestation, ["algorithm", "publicKey", "startedAt"], "attestation");
  equal(evidence.schemaVersion, 2, "schemaVersion");
  equal(evidence.capture?.browserContexts?.a, "codex-in-app-browser", "browser a");
  equal(evidence.capture?.browserContexts?.b, "chrome", "browser b");
  equal(evidence.capture?.originMode, "single-dano-origin", "origin mode");
  equal(evidence.capture?.seam, "Dano HTTP/SSE and visible acceptance UI", "public seam");
  for (const [key, value] of Object.entries(SETTINGS)) equal(evidence.cleanup?.[key], value, key);
  equal(evidence.attestation?.algorithm, "Ed25519", "attestation algorithm");
  date(evidence.attestation?.startedAt, "attestation startedAt");
  const publicKey = createPublicKey(evidence.attestation?.publicKey);
  const records = ledgerRaw.split(/\r?\n/).filter(Boolean).map(line => object(JSON.parse(line), "ledger record"));
  if (records.length !== TYPES.length) throw new Error("ledger must contain complete signed observations");
  let previous = Date.parse(evidence.preparedAt);
  records.forEach((record, index) => {
    equal(record.sequence, index + 1, "ledger sequence");
    equal(record.type, TYPES[index], "ledger type");
    equal(record.runId, evidence.runId, "ledger runId");
    exact(record, FIELDS[record.type], `ledger[${index}]`);
    const { signature, ...unsigned } = record;
    if (typeof signature !== "string" || !verifySignature(null, Buffer.from(JSON.stringify(unsigned)), publicKey, Buffer.from(signature, "base64url"))) {
      throw new Error(`ledger[${index}] signature is invalid`);
    }
    const occurred = date(record.occurredAt, "occurredAt");
    if (occurred <= previous) throw new Error("ledger timeline must be strictly monotonic");
    previous = occurred;
  });
  verifyRelations(evidence, records);
  verifyFinalRuntime(join(runRoot, "runtime"), records);
  console.log("real Anonymous User release gate passed");
}

function verifyRelations(evidence, r) {
  const [a, b, crossA, crossB, idle, a2, started, protectedTurn, released, postTurn, authenticated, authRetained] = r;
  own(a, "a", "anonymous", evidence.markers.a);
  own(b, "b", "anonymous", evidence.markers.b);
  cross(crossA, a, b, "a"); cross(crossB, b, a, "b");
  relation(idle.removedOwnerFingerprint, a.ownerFingerprint, "idle removed owner");
  relation(idle.removedWorkspaceFingerprint, a.workspaceFingerprint, "idle removed workspace");
  relation(idle.removedUploadFingerprint, a.uploadFingerprint, "idle removed upload");
  retained(idle, b);
  own(a2, "a2", "anonymous", evidence.markers.a2);
  relation(started.ownerFingerprint, a2.ownerFingerprint, "turn owner");
  relation(started.clientFingerprint, a2.clientFingerprint, "turn client");
  relation(started.workspaceFingerprint, a2.workspaceFingerprint, "turn workspace");
  relation(started.uploadFingerprint, a2.uploadFingerprint, "turn upload");
  relation(started.turnMarkerSha256, hash(evidence.markers.turn), "turn marker");
  equal(started.promptHttpStatus, 202, "turn prompt status"); hashField(started.providerRequestFingerprint, "provider request");
  for (const field of ["ownerFingerprint", "workspaceFingerprint", "uploadFingerprint", "providerRequestFingerprint"]) relation(protectedTurn[field], started[field], `protected ${field}`);
  equal(protectedTurn.disconnectedClientHttpStatus, 409, "disconnected turn client status");
  equal(protectedTurn.retainedPreviewHttpStatus, 200, "protected preview status");
  relation(protectedTurn.retainedPreviewSha256, a2.markerSha256, "protected preview");
  relation(released.providerRequestFingerprint, started.providerRequestFingerprint, "released provider request");
  equal(released.providerResponseHttpStatus, 200, "provider response status");
  for (const field of ["Owner", "Workspace", "Upload"]) relation(postTurn[`removed${field}Fingerprint`], a2[`${field.toLowerCase()}Fingerprint`], `post-turn removed ${field}`);
  relation(postTurn.retainedOwnerFingerprint, b.ownerFingerprint, "post-turn retained owner");
  own(authenticated, "authenticated", "authenticated", evidence.markers.authenticated);
  relation(authRetained.ownerFingerprint, authenticated.ownerFingerprint, "authenticated owner retained");
  relation(authRetained.workspaceFingerprint, authenticated.workspaceFingerprint, "authenticated workspace retained");
  relation(authRetained.uploadFingerprint, authenticated.uploadFingerprint, "authenticated upload retained");
  equal(authRetained.commandHttpStatus, 202, "authenticated command status");
  equal(authRetained.previewHttpStatus, 200, "authenticated preview status");
  relation(authRetained.previewSha256, authenticated.markerSha256, "authenticated preview");
}

function own(record, slot, authenticationStatus, markerValue) {
  equal(record.slot, slot, `${slot} slot`); equal(record.authenticationStatus, authenticationStatus, `${slot} authentication`);
  relation(record.markerSha256, hash(markerValue), `${slot} marker`);
  for (const field of ["ownerFingerprint", "clientFingerprint", "workspaceFingerprint", "uploadFingerprint"]) hashField(record[field], `${slot} ${field}`);
  equal(record.ownPreviewHttpStatus, 200, `${slot} preview status`); relation(record.ownPreviewSha256, record.markerSha256, `${slot} preview content`);
}

function cross(record, source, target, slot) {
  equal(record.slot, slot, `${slot} cross slot`); relation(record.sourceClientFingerprint, source.clientFingerprint, "cross source");
  relation(record.targetClientFingerprint, target.clientFingerprint, "cross target client"); relation(record.targetUploadFingerprint, target.uploadFingerprint, "cross target upload");
  equal(record.targetClientHttpStatus, 403, "cross client status"); equal(record.targetPreferenceHttpStatus, 403, "cross preference status"); equal(record.targetPreviewHttpStatus, 403, "cross preview status");
}

function retained(record, owner) {
  relation(record.retainedOwnerFingerprint, owner.ownerFingerprint, "retained owner"); relation(record.retainedWorkspaceFingerprint, owner.workspaceFingerprint, "retained workspace"); relation(record.retainedUploadFingerprint, owner.uploadFingerprint, "retained upload");
  equal(record.retainedCommandHttpStatus, 202, "retained command status"); equal(record.retainedPreviewHttpStatus, 200, "retained preview status"); relation(record.retainedPreviewSha256, owner.markerSha256, "retained preview");
}

function verifyFinalRuntime(runtimeRoot, records) {
  const inventory = runtimeInventory(runtimeRoot);
  const [a, b, , , , a2, , , , , authenticated] = records;
  for (const removed of [a, a2]) {
    absent(inventory.owners, removed.ownerFingerprint, "removed Anonymous User still exists"); absent(inventory.workspaces, removed.workspaceFingerprint, "removed workspace still exists"); absent(inventory.uploads, removed.uploadFingerprint, "removed upload still exists");
  }
  for (const kept of [b, authenticated]) {
    present(inventory.owners, kept.ownerFingerprint, `${kept.slot} retained User is missing`); present(inventory.workspaces, kept.workspaceFingerprint, `${kept.slot} retained workspace is missing (${kept.workspaceFingerprint}; found ${[...inventory.workspaces].join(",")})`); present(inventory.uploads, kept.uploadFingerprint, `${kept.slot} retained upload is missing`);
    relation(inventory.uploadContentHashes.get(kept.uploadFingerprint), kept.markerSha256, "retained upload content");
  }
}

function runtimeInventory(root) {
  const owners = new Set(), workspaces = new Set(), uploads = new Set(), uploadContentHashes = new Map();
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
  return { owners, workspaces, uploads, uploadContentHashes };
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
