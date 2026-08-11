import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createTlsServer } from "node:tls";

const root = resolve(import.meta.dirname, "..");
const entrypoint = join(root, "apps/dano/dist/server/main.js");
const temporaryRoot = mkdtempSync(join(tmpdir(), "dano-auth-entrypoint-"));
let provider;

try {
  const keyPath = join(temporaryRoot, "provider.key");
  const certificatePath = join(temporaryRoot, "provider.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
      "-keyout",
      keyPath,
      "-out",
      certificatePath,
    ],
    { stdio: "ignore" },
  );

  provider = createTlsServer({
    key: readFileSync(keyPath),
    cert: readFileSync(certificatePath),
  });
  const providerPort = await listen(provider);
  const targetPort = await reservePort();
  const runtimeDir = join(temporaryRoot, "runtime-must-not-exist");
  const baseEnvironment = {
    ...process.env,
    NODE_ENV: "production",
    NODE_EXTRA_CA_CERTS: certificatePath,
    DANO_RUNTIME_DIR: runtimeDir,
    DANO_PORT: String(targetPort),
    DANO_OAUTH_ISSUER: `https://localhost:${providerPort}`,
    DANO_OAUTH_AUTHORIZATION_ENDPOINT:
      `https://localhost:${providerPort}/authorize`,
    DANO_OAUTH_TOKEN_ENDPOINT: `https://localhost:${providerPort}/token`,
    DANO_OAUTH_IDENTITY_ENDPOINT: `https://localhost:${providerPort}/identity`,
    DANO_OAUTH_API_ORIGIN: `https://localhost:${providerPort}`,
    DANO_OAUTH_CLIENT_ID: "fixture-client",
    DANO_OAUTH_CLIENT_SECRET: "fixture-client-secret",
    DANO_OAUTH_SCOPE: "profile offline_access",
    DANO_OAUTH_REDIRECT_URI: "https://dano.invalid/api/auth/callback",
    DANO_OAUTH_CREDENTIAL_KEY: Buffer.alloc(32, 7).toString("base64url"),
    DANO_OAUTH_CREDENTIAL_KEY_VERSION: "fixture-v1",
  };

  const valid = await runEntrypoint(baseEnvironment);
  assertNoSensitiveOutput(valid, baseEnvironment);
  assert(valid.code === 0, "valid production configuration must succeed");
  assert(
    valid.stdout.includes("Production configuration is valid."),
    "valid production configuration must report success",
  );
  await assertConfigOnly(runtimeDir, targetPort);

  const hostnameMismatch = await runEntrypoint({
    ...baseEnvironment,
    DANO_OAUTH_ISSUER: `https://127.0.0.1:${providerPort}`,
    DANO_OAUTH_AUTHORIZATION_ENDPOINT:
      `https://127.0.0.1:${providerPort}/authorize`,
    DANO_OAUTH_TOKEN_ENDPOINT: `https://127.0.0.1:${providerPort}/token`,
    DANO_OAUTH_IDENTITY_ENDPOINT: `https://127.0.0.1:${providerPort}/identity`,
    DANO_OAUTH_API_ORIGIN: `https://127.0.0.1:${providerPort}`,
  });
  assertNoSensitiveOutput(hostnameMismatch, baseEnvironment);
  assert(hostnameMismatch.code !== 0, "TLS hostname mismatch must fail closed");
  assert(
    hostnameMismatch.stderr.includes("OAuth provider TLS validation failed"),
    "TLS failure must use a sanitized error",
  );
  await assertConfigOnly(runtimeDir, targetPort);

  const untrustedEnvironment = { ...baseEnvironment };
  delete untrustedEnvironment.NODE_EXTRA_CA_CERTS;
  const untrustedCertificate = await runEntrypoint(untrustedEnvironment);
  assertNoSensitiveOutput(untrustedCertificate, baseEnvironment);
  assert(
    untrustedCertificate.code !== 0,
    "untrusted TLS certificate chain must fail closed",
  );
  assert(
    untrustedCertificate.stderr.includes(
      "OAuth provider TLS validation failed",
    ),
    "certificate failure must use a sanitized error",
  );
  await assertConfigOnly(runtimeDir, targetPort);

  const incomplete = { ...baseEnvironment };
  delete incomplete.DANO_OAUTH_CLIENT_SECRET;
  const missing = await runEntrypoint(incomplete);
  assertNoSensitiveOutput(missing, baseEnvironment);
  assert(missing.code !== 0, "incomplete production configuration must fail");
  await assertConfigOnly(runtimeDir, targetPort);

  console.log("Production auth entrypoint gate passed.");
} finally {
  if (provider?.listening) {
    await new Promise(resolveClose => provider.close(resolveClose));
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function runEntrypoint(env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [entrypoint, "--validate-config"], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.once("error", rejectRun);
    child.once("exit", code => resolveRun({ code, stdout, stderr }));
  });
}

async function assertConfigOnly(runtimeDir, port) {
  assert(
    !existsSync(runtimeDir),
    "configuration validation must not write the runtime directory",
  );
  const listening = await canConnect(port);
  assert(!listening, "configuration validation must not start a listener");
}

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("TLS fixture did not bind a TCP port"));
        return;
      }
      resolveListen(address.port);
    });
  });
}

async function reservePort() {
  const server = createNetServer();
  const port = await listen(server);
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

function canConnect(port) {
  return new Promise(resolveConnect => {
    const client = connect({
      host: "127.0.0.1",
      port,
    });
    client.once("connect", () => {
      client.destroy();
      resolveConnect(true);
    });
    client.once("error", () => resolveConnect(false));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoSensitiveOutput(result, environment) {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const value of [
    environment.DANO_OAUTH_CLIENT_SECRET,
    environment.DANO_OAUTH_CREDENTIAL_KEY,
  ]) {
    assert(!output.includes(value), "configuration gate must not log secrets");
  }
}
