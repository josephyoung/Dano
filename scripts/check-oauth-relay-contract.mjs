#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readEnvValues } from "./deploy-env-file.mjs";

const deployRoot = process.env.DANO_DEPLOY_DIR || process.cwd();
const composeBin = process.env.DANO_COMPOSE || "docker";
const exposureFile = existsSync(join(deployRoot, "docker-compose.exposure.yml"))
  ? "docker-compose.exposure.yml"
  : `deploy/compose/${process.env.DANO_EXPOSURE_MODE?.trim() || "http"}.yml`;
const envFileArgs = existsSync(join(deployRoot, ".env"))
  ? ["--env-file", ".env"]
  : [];
const probeOrigin = "https://oauth-relay-contract.invalid";
const fileEnv = envFileArgs.length
  ? readEnvValues(readFileSync(join(deployRoot, ".env"), "utf8"))
  : new Map();
const envValue = name => process.env[name] ?? fileEnv.get(name);
const relayRequired = [
  "DANO_OAUTH_AUTHORIZATION_ENDPOINT",
  "DANO_OAUTH_TOKEN_ENDPOINT",
  "DANO_OAUTH_IDENTITY_ENDPOINT",
].some(name => hasRelayPath(envValue(name)));
if (relayRequired && !envValue("DANO_OAUTH_RELAY_ORIGIN")?.trim()) {
  fail("DANO_OAUTH_RELAY_ORIGIN is required for /admin-api/ OAuth endpoints");
}

// Let nginx parse the rendered configuration before inspecting active
// directives. This keeps comments and source formatting out of the contract.
const parsed = spawnSync(
  composeBin,
  [
    "compose",
    "-f",
    "docker-compose.yml",
    "-f",
    exposureFile,
    ...envFileArgs,
    "run",
    "--rm",
    "--no-deps",
    "nginx",
    "nginx",
    "-T",
  ],
  {
    cwd: deployRoot,
    encoding: "utf8",
    env: { ...process.env, DANO_OAUTH_RELAY_ORIGIN: probeOrigin },
  },
);
if (parsed.error || parsed.status !== 0) {
  fail("nginx rejected the rendered relay configuration");
}

const config = stripComments(parsed.stdout);
requireText(
  normalizeWhitespace(config),
  `set $dano_oauth_relay_origin "${probeOrigin}";`,
  "domain-independent relay origin injection",
);
const relayBlocks = [
  ...config.matchAll(/location\s+\^~\s+\/admin-api\/\s*\{([^{}]*)\}/gs),
].map(match => match[1]);
if (relayBlocks.length === 0) fail("missing /admin-api/ relay location");

for (const relay of relayBlocks) {
  const normalized = normalizeWhitespace(relay);
  if (/\brewrite\b/.test(relay)) {
    fail("/admin-api/ relay must preserve its upstream path");
  }
  requireText(normalized, "proxy_pass $dano_oauth_relay_origin;", "relay upstream");
  requireText(
    normalized,
    'proxy_set_header Accept-Encoding "";',
    "uncompressed rewriting",
  );
  requireText(normalized, "sub_filter_once off;", "dynamic resource rewriting");
  for (const marker of [
    "sub_filter '/assets/' '/admin-api/assets/';",
    "sub_filter '\"/logo' '\"/admin-api/logo';",
    `sub_filter "'/logo" "'/admin-api/logo";`,
    "sub_filter '(/logo' '(/admin-api/logo';",
    "sub_filter '`/logo' '`/admin-api/logo';",
    "sub_filter '=/logo' '=/admin-api/logo';",
    "sub_filter '\"/favicon' '\"/admin-api/favicon';",
    `sub_filter "'/favicon" "'/admin-api/favicon";`,
    "sub_filter '(/favicon' '(/admin-api/favicon';",
    "sub_filter '`/favicon' '`/admin-api/favicon';",
    "sub_filter '=/favicon' '=/admin-api/favicon';",
  ]) {
    requireText(normalized, marker, "isolated resource rewriting");
  }
  if (/proxy_pass\s+https?:\/\//.test(relay)) {
    fail("relay location must not hardcode an OAuth provider origin");
  }
}

console.log("[oauth-relay-contract] valid");

function stripComments(content) {
  return content
    .split("\n")
    .map(line => line.replace(/#.*/, ""))
    .join("\n");
}

function hasRelayPath(value) {
  if (!value?.trim()) return false;
  try {
    return new URL(value).pathname.startsWith("/admin-api/");
  } catch {
    return false;
  }
}

function normalizeWhitespace(content) {
  return content.replace(/\s+/g, " ").trim();
}

function requireText(content, marker, contract) {
  if (!content.includes(marker)) fail(`missing ${contract}`);
}

function fail(message) {
  throw new Error(`[oauth-relay-contract] ${message}`);
}
