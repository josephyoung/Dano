#!/usr/bin/env node
import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const DEFAULT_MANIFEST = fileURLToPath(
  new URL(
    "../apps/dano/src/__tests__/fixtures/real-oauth-acceptance.json",
    import.meta.url,
  ),
);
const BROWSER_PRODUCER = fileURLToPath(
  new URL("./real-user-isolation-browser.mjs", import.meta.url),
);
const SHA256 = /^[0-9a-f]{64}$/;
const FORBIDDEN_EVIDENCE =
  /https?:\/\/|password|client.?secret|access.?token|refresh.?token|cookie|authorization|private.?payload|raw-(?:client|session|workspace|upload)/i;
const RESOURCE_KEYS = ["client", "session", "workspace", "upload"];

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}

async function main(argv) {
  const [command, evidencePath, ...rest] = argv;
  if (command === "prepare") {
    throw new Error(
      "prepare was removed: use capture so the live HTTP/SSE/Pi collector observes the probes",
    );
  }
  if (command === "verify") {
    throw new Error(
      "offline verify cannot prove a live collector run or browser surface provenance; use capture for LIVE HTTP/SSE/Pi COLLECTOR PASS and an external IAB/Chrome acceptance record",
    );
  }
  if (!new Set(["capture", "audit"]).has(command) || !evidencePath) {
    throw new Error(
      "Usage: node scripts/check-real-user-isolation.mjs <capture|audit> <evidence.json> [--manifest <manifest.json>] [--origin <Dano origin>] [--port <port>] [--timeout-ms <milliseconds>]",
    );
  }
  const options = parseOptions(rest);
  const manifest = readManifest(options.manifestPath);
  if (command === "capture") {
    await captureEvidence(evidencePath, manifest, options);
    return;
  }
  auditEvidenceFile(evidencePath, manifest);
}

function parseOptions(argv) {
  const options = {
    manifestPath: DEFAULT_MANIFEST,
    origin: "http://localhost:5173",
    port: 0,
    timeoutMs: 10 * 60_000,
  };
  const optionNames = new Map([
    ["--manifest", "manifestPath"],
    ["--origin", "origin"],
    ["--port", "port"],
    ["--timeout-ms", "timeoutMs"],
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    const field = optionNames.get(name);
    if (!field || value === undefined) {
      throw new Error(`Unknown or incomplete argument: ${name ?? ""}`);
    }
    if (field === "port" || field === "timeoutMs") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`${name} must be a non-negative integer`);
      }
      options[field] = parsed;
    } else {
      options[field] = value;
    }
  }
  const origin = new URL(options.origin);
  if (
    !new Set(["http:", "https:"]).has(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("--origin must be a clean HTTP(S) Dano origin");
  }
  options.origin = origin.origin;
  if (options.timeoutMs < 1_000) {
    throw new Error("--timeout-ms must be at least 1000");
  }
  return options;
}

function readManifest(path) {
  const value = readJson(path, "manifest");
  assertRecord(value, "manifest");
  assertExactKeys(value, ["schemaVersion", "releaseGate", "accounts"], "manifest");
  if (value.schemaVersion !== 2) {
    throw new Error("manifest.schemaVersion must be 2");
  }
  assertRecord(value.releaseGate, "manifest.releaseGate");
  assertExactKeys(
    value.releaseGate,
    ["browserContexts", "callbackMode", "publicSeam"],
    "manifest.releaseGate",
  );
  if (
    value.releaseGate.browserContexts?.a !== "codex-in-app-browser" ||
    value.releaseGate.browserContexts?.b !== "chrome" ||
    value.releaseGate.callbackMode !== "single-shared-dano-callback" ||
    value.releaseGate.publicSeam !== "Dano HTTP/SSE/UI"
  ) {
    throw new Error(
      "manifest.releaseGate must use the in-app Browser, Chrome, one shared callback, and Dano HTTP/SSE/UI",
    );
  }
  if (!Array.isArray(value.accounts) || value.accounts.length !== 2) {
    throw new Error("manifest.accounts must contain exactly two test accounts");
  }
  const accounts = value.accounts.map((account, index) => {
    const path = `manifest.accounts[${index}]`;
    assertRecord(account, path);
    assertExactKeys(account, ["slot", "username", "password", "preference"], path);
    if (account.slot !== (index === 0 ? "a" : "b")) {
      throw new Error(`${path}.slot is invalid`);
    }
    for (const field of ["username", "password", "preference"]) {
      if (typeof account[field] !== "string" || !account[field]) {
        throw new Error(`${path}.${field} must be a non-empty string`);
      }
    }
    return account;
  });
  if (new Set(accounts.map(account => account.username)).size !== 2) {
    throw new Error("manifest accounts must use distinct usernames");
  }
  if (new Set(accounts.map(account => account.preference)).size !== 2) {
    throw new Error("manifest accounts must use distinct preferences");
  }
  return { schemaVersion: 2, releaseGate: value.releaseGate, accounts };
}

async function captureEvidence(evidencePath, manifest, options) {
  if (existsSync(evidencePath)) {
    throw new Error(`Evidence file already exists: ${evidencePath}`);
  }
  const producerSource = readFileSync(BROWSER_PRODUCER, "utf8");
  const producerSha256 = sha256(producerSource);
  const run = {
    runId: randomUUID(),
    preparedAt: new Date().toISOString(),
    tokens: {
      a: randomBytes(32).toString("hex"),
      b: randomBytes(32).toString("hex"),
    },
    markers: {
      a: `dano424-a-${randomBytes(16).toString("hex")}`,
      b: `dano424-b-${randomBytes(16).toString("hex")}`,
    },
    own: new Map(),
    cross: new Map(),
  };
  let finalized = false;
  let finalizationError;
  let completeCapture;
  let failCapture;
  const completion = new Promise((resolve, reject) => {
    completeCapture = resolve;
    failCapture = reject;
  });

  const server = createServer(async (request, response) => {
    try {
      await handleCaptureRequest({
        request,
        response,
        run,
        manifest,
        options,
        producerSource,
        producerSha256,
        onComplete: () => {
          if (finalized) return;
          finalized = true;
          try {
            writeAuditEvidence(
              evidencePath,
              run,
              manifest,
              producerSha256,
            );
            completeCapture();
          } catch (error) {
            finalizationError = error;
            failCapture(error);
          } finally {
            server.close();
          }
        },
      });
    } catch (error) {
      writeJsonResponse(response, 400, {
        error: error instanceof Error ? error.message : "capture request failed",
      }, options.origin);
    }
  });
  server.on("error", failCapture);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("capture server did not expose a TCP address");
  }
  const collector = `http://127.0.0.1:${address.port}`;
  process.stdout.write(`SLOT_A=${collector}/gate.mjs?slot=a&token=${run.tokens.a}\n`);
  process.stdout.write(`SLOT_B=${collector}/gate.mjs?slot=b&token=${run.tokens.b}\n`);
  process.stdout.write(
    "Import SLOT_A in the authenticated Codex in-app Browser and SLOT_B in authenticated Chrome; call run().\n",
  );

  const timeout = setTimeout(() => {
    if (finalized) return;
    finalized = true;
    server.close();
    failCapture(new Error("real User capture timed out before both browser slots completed"));
  }, options.timeoutMs);
  const terminate = () => {
    if (!finalized) {
      finalized = true;
      server.close();
      failCapture(new Error("real User capture was terminated"));
    }
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
  try {
    await completion;
    if (finalizationError) throw finalizationError;
    process.stdout.write(
      "LIVE HTTP/SSE/Pi COLLECTOR PASS: the active collector observed both slots complete authenticated own and bidirectional cross-User probes. Browser surface provenance is not application-layer proof; attach the external IAB/Chrome acceptance record.\n",
    );
    process.stdout.write(`Wrote redacted audit record: ${evidencePath}\n`);
  } finally {
    clearTimeout(timeout);
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
    if (server.listening) await new Promise(resolve => server.close(resolve));
  }
}

async function handleCaptureRequest(context) {
  const { request, response, options } = context;
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (request.method === "OPTIONS") {
    writeCorsHeaders(response, options.origin);
    response.statusCode = 204;
    response.end();
    return;
  }
  if (request.headers.origin !== options.origin) {
    writeJsonResponse(response, 403, { error: "unexpected browser origin" }, options.origin);
    return;
  }
  const slot = authenticatedSlot(url, context.run);
  if (!slot) {
    writeJsonResponse(response, 403, { error: "invalid capture slot" }, options.origin);
    return;
  }
  if (request.method === "GET" && url.pathname === "/gate.mjs") {
    writeCorsHeaders(response, options.origin);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.end(context.producerSource);
    return;
  }
  if (request.method === "GET" && url.pathname === "/config") {
    const account = accountForSlot(context.manifest, slot);
    writeJsonResponse(response, 200, {
      slot,
      marker: context.run.markers[slot],
      preference: account.preference,
      expectedBrowser: context.manifest.releaseGate.browserContexts[slot],
    }, options.origin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/own") {
    if (context.run.own.has(slot)) {
      writeJsonResponse(response, 409, { error: "own phase already captured" }, options.origin);
      return;
    }
    const value = await readRequestJson(request);
    const captured = validateOwnCapture(
      value,
      context.run.markers[slot],
      accountForSlot(context.manifest, slot).preference,
    );
    context.run.own.set(slot, captured);
    if (context.run.own.size === 2) {
      try {
        validateDistinctOwners(context.run.own);
      } catch (error) {
        context.run.own.delete(slot);
        throw error;
      }
    }
    writeJsonResponse(response, 202, { status: "own-captured" }, options.origin);
    return;
  }
  if (request.method === "GET" && url.pathname === "/peer") {
    if (context.run.own.size !== 2) {
      writeJsonResponse(response, 425, { status: "waiting-for-peer" }, options.origin);
      return;
    }
    const peer = context.run.own.get(slot === "a" ? "b" : "a");
    writeJsonResponse(response, 200, peer.raw, options.origin);
    return;
  }
  if (request.method === "POST" && url.pathname === "/cross") {
    if (context.run.own.size !== 2) {
      writeJsonResponse(response, 425, { error: "own phases are incomplete" }, options.origin);
      return;
    }
    if (context.run.cross.has(slot)) {
      writeJsonResponse(response, 409, { error: "cross phase already captured" }, options.origin);
      return;
    }
    const peer = context.run.own.get(slot === "a" ? "b" : "a");
    const value = await readRequestJson(request);
    context.run.cross.set(slot, validateCrossCapture(value, peer.raw));
    writeJsonResponse(response, 202, { status: "cross-captured" }, options.origin);
    if (context.run.cross.size === 2) setImmediate(context.onComplete);
    return;
  }
  writeJsonResponse(response, 404, { error: "capture route was not found" }, options.origin);
}

function authenticatedSlot(url, run) {
  const slot = url.searchParams.get("slot");
  const token = url.searchParams.get("token");
  return (slot === "a" || slot === "b") && token === run.tokens[slot]
    ? slot
    : null;
}

function validateOwnCapture(value, marker, expectedPreference) {
  assertRecord(value, "own capture");
  assertExactKeys(
    value,
    ["authenticationStatus", "runtimeOwnerFingerprint", "raw", "own"],
    "own capture",
  );
  if (value.authenticationStatus !== "authenticated") {
    throw new Error("browser slot must be authenticated");
  }
  assertSha256(value.runtimeOwnerFingerprint, "runtimeOwnerFingerprint");
  const raw = validateRawResources(value.raw);
  assertRecord(value.own, "own capture.own");
  assertExactKeys(
    value.own,
    [
      "resourceFingerprints",
      "sessionMarkerCount",
      "sessionOpen",
      "transcriptMarkerCount",
      "workspaceMarkerSha256",
      "uploadPreviewSha256",
      "preference",
    ],
    "own capture.own",
  );
  validateResourceFingerprints(value.own.resourceFingerprints, raw);
  requireEqual(value.own.sessionMarkerCount, 1, "own.sessionMarkerCount");
  requireEqual(value.own.sessionOpen, "succeeded", "own.sessionOpen");
  requireEqual(value.own.transcriptMarkerCount, 1, "own.transcriptMarkerCount");
  requireEqual(value.own.workspaceMarkerSha256, sha256(marker), "own.workspaceMarkerSha256");
  requireEqual(value.own.uploadPreviewSha256, sha256(marker), "own.uploadPreviewSha256");
  requireEqual(value.own.preference, expectedPreference, "own.preference");
  return {
    runtimeOwnerFingerprint: value.runtimeOwnerFingerprint,
    raw,
    own: value.own,
  };
}

function validateRawResources(value) {
  assertRecord(value, "own capture.raw");
  assertExactKeys(
    value,
    ["clientId", "sessionPath", "workspacePath", "uploadId", "uploadRelativePath"],
    "own capture.raw",
  );
  for (const field of [
    "clientId",
    "sessionPath",
    "workspacePath",
    "uploadId",
    "uploadRelativePath",
  ]) {
    if (typeof value[field] !== "string" || !value[field]) {
      throw new Error(`own capture.raw.${field} must be a non-empty string`);
    }
  }
  return { ...value };
}

function validateCrossCapture(value, peerRaw) {
  assertRecord(value, "cross capture");
  assertExactKeys(
    value,
    [
      "targetFingerprints",
      "forgedClientHttpStatus",
      "sessionList",
      "sessionOpen",
      "transcriptRead",
      "workspaceRegister",
      "workspaceList",
      "workspaceRead",
      "uploadPreviewHttpStatus",
      "preferenceReadHttpStatus",
      "preferenceRestored",
    ],
    "cross capture",
  );
  validateResourceFingerprints(value.targetFingerprints, peerRaw);
  requireEqual(value.forgedClientHttpStatus, 403, "cross.forgedClientHttpStatus");
  for (const field of [
    "sessionList",
    "sessionOpen",
    "transcriptRead",
    "workspaceRegister",
    "workspaceList",
    "workspaceRead",
  ]) {
    requireEqual(value[field], "rejected", `cross.${field}`);
  }
  requireEqual(value.uploadPreviewHttpStatus, 403, "cross.uploadPreviewHttpStatus");
  requireEqual(value.preferenceReadHttpStatus, 403, "cross.preferenceReadHttpStatus");
  requireEqual(value.preferenceRestored, true, "cross.preferenceRestored");
  return { ...value };
}

function validateDistinctOwners(own) {
  const a = own.get("a");
  const b = own.get("b");
  if (a.runtimeOwnerFingerprint === b.runtimeOwnerFingerprint) {
    throw new Error("browser slots resolved to the same canonical User owner");
  }
  for (const field of Object.keys(a.raw)) {
    if (a.raw[field] === b.raw[field]) {
      throw new Error(`browser slots reused raw ${field}`);
    }
  }
}

function writeAuditEvidence(path, run, manifest, producerSha256) {
  const evidence = {
    schemaVersion: 2,
    runId: run.runId,
    preparedAt: run.preparedAt,
    completedAt: new Date().toISOString(),
    capture: {
      expectedBrowserContexts: manifest.releaseGate.browserContexts,
      callbackMode: manifest.releaseGate.callbackMode,
      seam: manifest.releaseGate.publicSeam,
      producer: "live-browser-module",
      producerSha256,
    },
    accounts: manifest.accounts.map(account => {
      const own = run.own.get(account.slot);
      const cross = run.cross.get(account.slot);
      return {
        slot: account.slot,
        username: account.username,
        markerSha256: sha256(run.markers[account.slot]),
        runtimeOwnerFingerprint: own.runtimeOwnerFingerprint,
        own: own.own,
        cross,
      };
    }),
    recordPurpose: "redacted-audit-only-not-live-proof",
  };
  const raw = `${JSON.stringify(evidence, null, 2)}\n`;
  const errors = verifyEvidenceContract(evidence, manifest, raw);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function auditEvidenceFile(path, manifest) {
  const raw = readFileSync(path, "utf8");
  const evidence = JSON.parse(raw);
  const errors = verifyEvidenceContract(evidence, manifest, raw);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  process.stdout.write(
    "AUDIT ONLY (NOT LIVE COLLECTOR PASS): redacted record structure is valid, but an offline file cannot prove a live run or browser surface provenance.\n",
  );
}

function verifyEvidenceContract(value, manifest, raw) {
  const errors = [];
  if (FORBIDDEN_EVIDENCE.test(raw)) {
    errors.push("evidence contains forbidden provider, credential, URL, or raw resource data");
  }
  collectEqual(value.schemaVersion, 2, "schemaVersion", errors);
  collectEqual(
    value.recordPurpose,
    "redacted-audit-only-not-live-proof",
    "recordPurpose",
    errors,
  );
  collectMatch(value.runId, /^[0-9a-f-]{36}$/i, "runId", errors);
  collectIsoDate(value.preparedAt, "preparedAt", errors);
  collectIsoDate(value.completedAt, "completedAt", errors);
  collectEqual(
    value.capture?.expectedBrowserContexts?.a,
    "codex-in-app-browser",
    "capture.expectedBrowserContexts.a",
    errors,
  );
  collectEqual(
    value.capture?.expectedBrowserContexts?.b,
    "chrome",
    "capture.expectedBrowserContexts.b",
    errors,
  );
  collectEqual(
    value.capture?.callbackMode,
    "single-shared-dano-callback",
    "capture.callbackMode",
    errors,
  );
  collectEqual(value.capture?.seam, "Dano HTTP/SSE/UI", "capture.seam", errors);
  collectEqual(value.capture?.producer, "live-browser-module", "capture.producer", errors);
  collectEqual(
    value.capture?.producerSha256,
    sha256(readFileSync(BROWSER_PRODUCER)),
    "capture.producerSha256",
    errors,
  );
  if (!Array.isArray(value.accounts) || value.accounts.length !== 2) {
    errors.push("accounts must contain exactly two captured slots");
    return errors;
  }
  const bySlot = new Map(value.accounts.map(account => [account?.slot, account]));
  for (const expected of manifest.accounts) {
    const account = bySlot.get(expected.slot);
    const path = `accounts[${expected.slot}]`;
    collectEqual(account?.username, expected.username, `${path}.username`, errors);
    collectMatch(account?.markerSha256, SHA256, `${path}.markerSha256`, errors);
    collectMatch(
      account?.runtimeOwnerFingerprint,
      SHA256,
      `${path}.runtimeOwnerFingerprint`,
      errors,
    );
    verifySanitizedOwn(account?.own, expected.preference, `${path}.own`, errors);
    verifySanitizedCross(account?.cross, `${path}.cross`, errors);
    collectEqual(
      account?.own?.workspaceMarkerSha256,
      account?.markerSha256,
      `${path}.own.workspaceMarkerSha256`,
      errors,
    );
    collectEqual(
      account?.own?.uploadPreviewSha256,
      account?.markerSha256,
      `${path}.own.uploadPreviewSha256`,
      errors,
    );
  }
  const a = bySlot.get("a");
  const b = bySlot.get("b");
  if (a?.runtimeOwnerFingerprint === b?.runtimeOwnerFingerprint) {
    errors.push("captured browser slots must use different canonical User owners");
  }
  for (const resource of RESOURCE_KEYS) {
    if (
      a?.own?.resourceFingerprints?.[resource] ===
      b?.own?.resourceFingerprints?.[resource]
    ) {
      errors.push(`captured browser slots must use different ${resource} resources`);
    }
    collectEqual(
      a?.cross?.targetFingerprints?.[resource],
      b?.own?.resourceFingerprints?.[resource],
      `accounts[a].cross.targetFingerprints.${resource}`,
      errors,
    );
    collectEqual(
      b?.cross?.targetFingerprints?.[resource],
      a?.own?.resourceFingerprints?.[resource],
      `accounts[b].cross.targetFingerprints.${resource}`,
      errors,
    );
  }
  return errors;
}

function verifySanitizedOwn(value, preference, path, errors) {
  verifySanitizedFingerprints(value?.resourceFingerprints, `${path}.resourceFingerprints`, errors);
  collectEqual(value?.sessionMarkerCount, 1, `${path}.sessionMarkerCount`, errors);
  collectEqual(value?.sessionOpen, "succeeded", `${path}.sessionOpen`, errors);
  collectEqual(value?.transcriptMarkerCount, 1, `${path}.transcriptMarkerCount`, errors);
  collectMatch(value?.workspaceMarkerSha256, SHA256, `${path}.workspaceMarkerSha256`, errors);
  collectMatch(value?.uploadPreviewSha256, SHA256, `${path}.uploadPreviewSha256`, errors);
  collectEqual(value?.preference, preference, `${path}.preference`, errors);
}

function verifySanitizedCross(value, path, errors) {
  verifySanitizedFingerprints(value?.targetFingerprints, `${path}.targetFingerprints`, errors);
  collectEqual(value?.forgedClientHttpStatus, 403, `${path}.forgedClientHttpStatus`, errors);
  for (const field of [
    "sessionList",
    "sessionOpen",
    "transcriptRead",
    "workspaceRegister",
    "workspaceList",
    "workspaceRead",
  ]) {
    collectEqual(value?.[field], "rejected", `${path}.${field}`, errors);
  }
  collectEqual(value?.uploadPreviewHttpStatus, 403, `${path}.uploadPreviewHttpStatus`, errors);
  collectEqual(value?.preferenceReadHttpStatus, 403, `${path}.preferenceReadHttpStatus`, errors);
  collectEqual(value?.preferenceRestored, true, `${path}.preferenceRestored`, errors);
}

function verifySanitizedFingerprints(value, path, errors) {
  for (const resource of RESOURCE_KEYS) {
    collectMatch(value?.[resource], SHA256, `${path}.${resource}`, errors);
  }
}

function validateResourceFingerprints(value, raw) {
  assertRecord(value, "resourceFingerprints");
  assertExactKeys(value, RESOURCE_KEYS, "resourceFingerprints");
  const expected = {
    client: sha256(raw.clientId),
    session: sha256(raw.sessionPath),
    workspace: sha256(raw.workspacePath),
    upload: sha256(raw.uploadId),
  };
  for (const resource of RESOURCE_KEYS) {
    requireEqual(value[resource], expected[resource], `resourceFingerprints.${resource}`);
  }
}

function accountForSlot(manifest, slot) {
  return manifest.accounts.find(account => account.slot === slot);
}

async function readRequestJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 64 * 1024) throw new Error("capture request is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("capture request must contain valid JSON");
  }
}

function writeCorsHeaders(response, origin) {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Vary", "Origin");
}

function writeJsonResponse(response, status, body, origin) {
  writeCorsHeaders(response, origin);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(`${JSON.stringify(body)}\n`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertSha256(value, path) {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${path} must be a SHA-256 fingerprint`);
  }
}

function requireEqual(actual, expected, path) {
  if (actual !== expected) {
    throw new Error(`${path} must equal ${JSON.stringify(expected)}`);
  }
}

function collectEqual(actual, expected, path, errors) {
  if (actual !== expected) errors.push(`${path} must equal ${JSON.stringify(expected)}`);
}

function collectMatch(value, expression, path, errors) {
  if (typeof value !== "string" || !expression.test(value)) {
    errors.push(`${path} has an invalid format`);
  }
}

function collectIsoDate(value, path, errors) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    errors.push(`${path} must be an ISO timestamp`);
  }
}

function assertExactKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${path} must contain only: ${wanted.join(", ")}`);
  }
}

function assertRecord(value, path) {
  if (!isRecord(value)) throw new Error(`${path} must be a JSON object`);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${label} JSON at ${path}`, { cause: error });
  }
}
