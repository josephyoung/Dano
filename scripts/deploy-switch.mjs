#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const action = process.argv[2];
if (action !== "switch" && action !== "rollback") {
  throw new Error("Usage: node scripts/deploy-switch.mjs <switch|rollback>");
}

const composeBin = process.env.DANO_COMPOSE || "docker";
const composeArgs = ["compose"];
const envFileArgs = existsSync(".env") ? ["--env-file", ".env"] : [];
const composeFileArgs = [
  "-f",
  "docker-compose.yml",
  "-f",
  existsSync("docker-compose.exposure.yml")
    ? "docker-compose.exposure.yml"
    : `deploy/compose/${process.env.DANO_EXPOSURE_MODE?.trim() || "http"}.yml`,
];
const healthAttempts = positiveInteger(
  "DANO_DEPLOY_HEALTH_ATTEMPTS",
  process.env.DANO_DEPLOY_HEALTH_ATTEMPTS,
  60,
);
const healthIntervalMs = positiveInteger(
  "DANO_DEPLOY_HEALTH_INTERVAL_MS",
  process.env.DANO_DEPLOY_HEALTH_INTERVAL_MS,
  1_000,
);

function execute(args, { capture = false } = {}) {
  const result = spawnSync(composeBin, args, {
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? "pipe" : "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${composeBin} exited with ${result.status ?? 1}`);
  }
  return capture ? result.stdout.trim() : "";
}

function compose(args, options) {
  return execute(
    [...composeArgs, ...composeFileArgs, ...envFileArgs, ...args],
    options,
  );
}

function waitForHealthyApp() {
  const containerId = compose(["ps", "-q", "app"], { capture: true });
  if (!containerId || /\s/.test(containerId)) {
    throw new Error("Dano app container identity is unavailable or ambiguous");
  }

  for (let attempt = 0; attempt < healthAttempts; attempt++) {
    const status = execute(
      ["inspect", "--format", "{{.State.Health.Status}}", containerId],
      { capture: true },
    );
    if (status === "healthy") return;
    if (status === "unhealthy") {
      throw new Error("Dano app became unhealthy before nginx update");
    }
    if (attempt + 1 < healthAttempts) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        healthIntervalMs,
      );
    }
  }
  throw new Error("Timed out waiting for the Dano app healthcheck");
}

console.log(
  `[deploy-switch] ${action}: updating app while current nginx stays online`,
);
compose(["up", "-d", "--no-build", "--no-deps", "app"]);
waitForHealthyApp();
console.log(`[deploy-switch] ${action}: app is healthy; updating nginx`);
compose(["up", "-d", "--no-build", "--no-deps", "nginx"]);

function positiveInteger(name, value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}
