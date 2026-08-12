import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const DEFAULT_MANIFEST = fileURLToPath(
  new URL(
    "../apps/dano/src/__tests__/fixtures/real-oauth-acceptance.json",
    import.meta.url,
  ),
);
const EXACT_STATUS = new Set(["succeeded", "rejected"]);
const FORBIDDEN_EVIDENCE = /https?:\/\/|password|client.?secret|access.?token|refresh.?token|cookie|authorization|private.?payload/i;

function main(argv) {
  const { command, evidencePath, manifestPath } = parseArguments(argv);
  const manifest = readManifest(manifestPath);
  if (command === "prepare") {
    prepareEvidence(evidencePath, manifest);
    process.stdout.write(`Prepared real OAuth User evidence: ${evidencePath}\n`);
    return;
  }

  const evidence = readJson(evidencePath, "evidence");
  const errors = verifyEvidence(evidence, manifest, readFileSync(evidencePath, "utf8"));
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  process.stdout.write(
    "Real OAuth User isolation evidence contract passed: the in-app Browser observations describe two isolated canonical User owners at the Dano HTTP/Bridge boundary.\n",
  );
}

function parseArguments(argv) {
  const [command, evidencePath, ...rest] = argv;
  if (!new Set(["prepare", "verify"]).has(command) || !evidencePath) {
    throw new Error(
      "Usage: node scripts/check-real-user-isolation.mjs <prepare|verify> <evidence.json> [--manifest <manifest.json>]",
    );
  }
  let manifestPath = DEFAULT_MANIFEST;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] !== "--manifest" || !rest[index + 1]) {
      throw new Error(`Unknown or incomplete argument: ${rest[index] ?? ""}`);
    }
    manifestPath = rest[index + 1];
    index += 1;
  }
  return { command, evidencePath, manifestPath };
}

function readManifest(path) {
  const value = readJson(path, "manifest");
  assertRecord(value, "manifest");
  assertExactKeys(
    value,
    ["schemaVersion", "releaseGate", "accounts"],
    "manifest",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("manifest.schemaVersion must be 1");
  }
  if (!Array.isArray(value.accounts) || value.accounts.length !== 2) {
    throw new Error("manifest.accounts must contain exactly two test accounts");
  }
  assertRecord(value.releaseGate, "manifest.releaseGate");
  assertExactKeys(
    value.releaseGate,
    ["browser", "publicSeam", "browserInput", "automatedContract"],
    "manifest.releaseGate",
  );
  if (
    value.releaseGate.browser !== "codex-in-app-browser" ||
    value.releaseGate.publicSeam !== "Dano HTTP/Bridge"
  ) {
    throw new Error("manifest.releaseGate must use the in-app Browser and Dano HTTP/Bridge seam");
  }
  for (const field of ["browserInput", "automatedContract"]) {
    if (
      !Array.isArray(value.releaseGate[field]) ||
      value.releaseGate[field].length === 0 ||
      value.releaseGate[field].some(item => typeof item !== "string")
    ) {
      throw new Error(`manifest.releaseGate.${field} must be a non-empty string list`);
    }
  }
  const accounts = value.accounts.map((account, index) => {
    const path = `manifest.accounts[${index}]`;
    assertRecord(account, path);
    assertExactKeys(
      account,
      ["slot", "username", "password", "preference"],
      path,
    );
    if (!new Set(["a", "b"]).has(account.slot)) {
      throw new Error(`${path}.slot must be a or b`);
    }
    for (const field of ["username", "password", "preference"]) {
      if (typeof account[field] !== "string" || account[field].length === 0) {
        throw new Error(`${path}.${field} must be a non-empty string`);
      }
    }
    return account;
  });
  if (new Set(accounts.map(account => account.slot)).size !== 2) {
    throw new Error("manifest accounts must use distinct slots");
  }
  if (new Set(accounts.map(account => account.username)).size !== 2) {
    throw new Error("manifest accounts must use distinct usernames");
  }
  if (new Set(accounts.map(account => account.preference)).size !== 2) {
    throw new Error("manifest accounts must use distinct preference markers");
  }
  return { schemaVersion: 1, releaseGate: value.releaseGate, accounts };
}

function prepareEvidence(path, manifest) {
  if (existsSync(path)) {
    throw new Error(`Evidence file already exists: ${path}`);
  }
  const runId = randomUUID();
  const preparedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 1,
    runId,
    preparedAt,
    completedAt: null,
    capture: {
      browser: "codex-in-app-browser",
      seam: "Dano HTTP/Bridge",
    },
    accounts: manifest.accounts.map(account => ({
      slot: account.slot,
      username: account.username,
      marker: `dano424-${account.slot}-${randomBytes(12).toString("hex")}`,
      expectedPreference: account.preference,
      observations: emptyObservations(),
    })),
  };
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function emptyObservations() {
  return {
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
  };
}

function verifyEvidence(value, manifest, rawEvidence) {
  const errors = [];
  if (FORBIDDEN_EVIDENCE.test(rawEvidence)) {
    errors.push("evidence contains forbidden provider or credential material");
  }
  if (!isRecord(value)) return ["evidence must be a JSON object"];
  collectExactKeys(
    value,
    [
      "schemaVersion",
      "runId",
      "preparedAt",
      "completedAt",
      "capture",
      "accounts",
    ],
    "evidence",
    errors,
  );
  collectEqual(value.schemaVersion, 1, "evidence.schemaVersion", errors);
  collectMatch(
    value.runId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "evidence.runId",
    errors,
  );
  collectIsoDate(value.preparedAt, "evidence.preparedAt", errors);
  collectIsoDate(value.completedAt, "evidence.completedAt", errors);
  if (
    typeof value.preparedAt === "string" &&
    typeof value.completedAt === "string" &&
    Date.parse(value.completedAt) < Date.parse(value.preparedAt)
  ) {
    errors.push("evidence.completedAt must not precede preparedAt");
  }
  verifyCapture(value.capture, errors);
  if (!Array.isArray(value.accounts) || value.accounts.length !== 2) {
    errors.push("evidence.accounts must contain exactly two browser observations");
    return errors;
  }

  const observedFingerprints = [];
  const observedMarkers = [];
  const accountsBySlot = new Map();
  for (const expected of manifest.accounts) {
    const account = value.accounts.find(candidate => candidate?.slot === expected.slot);
    const path = `evidence.accounts[${expected.slot}]`;
    if (!account) {
      errors.push(`${path} is required`);
      continue;
    }
    verifyAccount(account, expected, path, errors);
    accountsBySlot.set(expected.slot, account);
    if (typeof account.marker === "string") observedMarkers.push(account.marker);
    const fingerprint = account.observations?.runtimeOwnerFingerprint;
    if (typeof fingerprint === "string") observedFingerprints.push(fingerprint);
  }
  if (new Set(observedMarkers).size !== 2) {
    errors.push("evidence accounts must use different run markers");
  }
  if (
    observedFingerprints.length !== 2 ||
    new Set(observedFingerprints).size !== 2
  ) {
    errors.push("evidence must identify two different canonical User owners");
  }
  const accountA = accountsBySlot.get("a");
  const accountB = accountsBySlot.get("b");
  if (accountA && accountB) {
    verifyCrossTargets(accountA, accountB, "evidence.accounts[a]", errors);
    verifyCrossTargets(accountB, accountA, "evidence.accounts[b]", errors);
  }
  return errors;
}

function verifyCrossTargets(account, counterpart, path, errors) {
  const targets = account.observations?.cross?.targetFingerprints;
  const resources = counterpart.observations?.own?.resourceFingerprints;
  for (const resource of ["client", "session", "workspace", "upload"]) {
    collectEqual(
      targets?.[resource],
      resources?.[resource],
      `${path}.observations.cross.targetFingerprints.${resource}`,
      errors,
    );
  }
}

function verifyCapture(value, errors) {
  if (!isRecord(value)) {
    errors.push("evidence.capture must be an object");
    return;
  }
  collectExactKeys(value, ["browser", "seam"], "evidence.capture", errors);
  collectEqual(
    value.browser,
    "codex-in-app-browser",
    "evidence.capture.browser",
    errors,
  );
  collectEqual(value.seam, "Dano HTTP/Bridge", "evidence.capture.seam", errors);
}

function verifyAccount(account, expected, path, errors) {
  if (!isRecord(account)) {
    errors.push(`${path} must be an object`);
    return;
  }
  collectExactKeys(
    account,
    ["slot", "username", "marker", "expectedPreference", "observations"],
    path,
    errors,
  );
  collectEqual(account.slot, expected.slot, `${path}.slot`, errors);
  collectEqual(account.username, expected.username, `${path}.username`, errors);
  collectEqual(
    account.expectedPreference,
    expected.preference,
    `${path}.expectedPreference`,
    errors,
  );
  collectMatch(
    account.marker,
    new RegExp(`^dano424-${expected.slot}-[0-9a-f]{24}$`),
    `${path}.marker`,
    errors,
  );
  verifyObservations(
    account.observations,
    account.marker,
    expected.preference,
    `${path}.observations`,
    errors,
  );
}

function verifyObservations(value, marker, expectedPreference, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} must be filled from one authenticated browser context`);
    return;
  }
  collectExactKeys(
    value,
    ["authenticationStatus", "runtimeOwnerFingerprint", "own", "cross"],
    path,
    errors,
  );
  collectEqual(
    value.authenticationStatus,
    "authenticated",
    `${path}.authenticationStatus`,
    errors,
  );
  collectMatch(
    value.runtimeOwnerFingerprint,
    /^[0-9a-f]{64}$/,
    `${path}.runtimeOwnerFingerprint`,
    errors,
  );
  const markerSha256 =
    typeof marker === "string"
      ? createHash("sha256").update(marker).digest("hex")
      : "";
  verifyOwn(value.own, markerSha256, expectedPreference, `${path}.own`, errors);
  verifyCross(value.cross, `${path}.cross`, errors);
}

function verifyOwn(value, markerSha256, expectedPreference, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  collectExactKeys(
    value,
    [
      "resourceFingerprints",
      "sessionMarkerCount",
      "sessionOpen",
      "transcriptMarkerCount",
      "workspaceMarkerSha256",
      "uploadPreviewSha256",
      "preference",
    ],
    path,
    errors,
  );
  verifyResourceFingerprints(
    value.resourceFingerprints,
    `${path}.resourceFingerprints`,
    errors,
  );
  collectEqual(value.sessionMarkerCount, 1, `${path}.sessionMarkerCount`, errors);
  collectEqual(value.sessionOpen, "succeeded", `${path}.sessionOpen`, errors);
  collectEqual(
    value.transcriptMarkerCount,
    1,
    `${path}.transcriptMarkerCount`,
    errors,
  );
  collectEqual(
    value.workspaceMarkerSha256,
    markerSha256,
    `${path}.workspaceMarkerSha256`,
    errors,
  );
  collectEqual(
    value.uploadPreviewSha256,
    markerSha256,
    `${path}.uploadPreviewSha256`,
    errors,
  );
  collectEqual(value.preference, expectedPreference, `${path}.preference`, errors);
}

function verifyCross(value, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  collectExactKeys(
    value,
    [
      "targetFingerprints",
      "sessionMarkerCount",
      "sessionOpen",
      "transcriptMarkerCount",
      "workspaceRead",
      "uploadPreviewHttpStatus",
      "preferenceReadHttpStatus",
    ],
    path,
    errors,
  );
  verifyResourceFingerprints(
    value.targetFingerprints,
    `${path}.targetFingerprints`,
    errors,
  );
  collectEqual(value.sessionMarkerCount, 0, `${path}.sessionMarkerCount`, errors);
  collectRejected(value.sessionOpen, `${path}.sessionOpen`, errors);
  collectEqual(
    value.transcriptMarkerCount,
    0,
    `${path}.transcriptMarkerCount`,
    errors,
  );
  collectRejected(value.workspaceRead, `${path}.workspaceRead`, errors);
  collectEqual(
    value.uploadPreviewHttpStatus,
    403,
    `${path}.uploadPreviewHttpStatus`,
    errors,
  );
  collectEqual(
    value.preferenceReadHttpStatus,
    403,
    `${path}.preferenceReadHttpStatus`,
    errors,
  );
}

function verifyResourceFingerprints(value, path, errors) {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  collectExactKeys(
    value,
    ["client", "session", "workspace", "upload"],
    path,
    errors,
  );
  for (const resource of ["client", "session", "workspace", "upload"]) {
    collectMatch(value[resource], /^[0-9a-f]{64}$/, `${path}.${resource}`, errors);
  }
}

function collectRejected(value, path, errors) {
  if (!EXACT_STATUS.has(value) || value !== "rejected") {
    errors.push(`${path} must be rejected`);
  }
}

function collectEqual(actual, expected, path, errors) {
  if (actual !== expected) {
    errors.push(`${path} must equal ${JSON.stringify(expected)}`);
  }
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

function collectExactKeys(value, expected, path, errors) {
  if (!isRecord(value)) return;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    errors.push(`${path} must contain only: ${wanted.join(", ")}`);
  }
}

function assertExactKeys(value, expected, path) {
  const errors = [];
  collectExactKeys(value, expected, path, errors);
  if (errors.length > 0) throw new Error(errors[0]);
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

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
