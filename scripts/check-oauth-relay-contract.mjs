#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const deployRoot = process.env.DANO_DEPLOY_DIR || process.cwd();
const deployedCompose = join(deployRoot, "docker-compose.yml");
const composePath = existsSync(deployedCompose)
  ? deployedCompose
  : join(sourceRoot, "docker-compose.yml");
const sharedDir =
  process.env.DANO_NGINX_SHARED_DIR ||
  (existsSync(join(deployRoot, "nginx/shared"))
    ? join(deployRoot, "nginx/shared")
    : join(sourceRoot, "deploy/nginx/shared"));
const configuredTemplate =
  process.env.DANO_NGINX_CONF || join(deployRoot, "nginx/default.conf.template");
const templatePaths = existsSync(configuredTemplate)
  ? [configuredTemplate]
  : ["http", "https", "both", "both-no-redirect-http"].map(mode =>
      join(sourceRoot, `deploy/nginx/${mode}.conf.template`),
    );

const compose = readFileSync(composePath, "utf8");
const proxy = readFileSync(join(sharedDir, "proxy-server.conf"), "utf8");
const relayStart = proxy.indexOf("location ^~ /admin-api/");
const relayEnd = proxy.indexOf("\n}\n", relayStart);
if (relayStart < 0 || relayEnd < 0) fail("missing /admin-api/ relay location");
const relay = proxy.slice(relayStart, relayEnd + 2);

requireText(
  compose,
  "DANO_OAUTH_RELAY_ORIGIN: ${DANO_OAUTH_RELAY_ORIGIN:-http://127.0.0.1:9}",
  "Compose relay origin",
);
for (const path of templatePaths) {
  requireText(
    readFileSync(path, "utf8"),
    'set $dano_oauth_relay_origin "${DANO_OAUTH_RELAY_ORIGIN}";',
    "nginx relay origin injection",
  );
}
requireText(relay, "rewrite ^/admin-api(/.*)$ $1 break;", "prefix stripping");
requireText(relay, "proxy_pass $dano_oauth_relay_origin;", "relay upstream");
requireText(
  relay,
  'proxy_set_header Accept-Encoding "";',
  "uncompressed rewriting",
);
requireText(relay, "sub_filter_once off;", "dynamic resource rewriting");
for (const marker of [
  "sub_filter '/assets/' '/admin-api/assets/';",
  "/admin-api/logo",
  "/admin-api/favicon",
]) {
  requireText(relay, marker, "isolated resource rewriting");
}
if (/https?:\/\//.test(relay)) {
  fail("relay location must not hardcode an OAuth provider origin");
}

console.log("[oauth-relay-contract] valid");

function requireText(content, marker, contract) {
  if (!content.includes(marker)) fail(`missing ${contract}`);
}

function fail(message) {
  throw new Error(`[oauth-relay-contract] ${message}`);
}
