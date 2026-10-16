#!/usr/bin/env node
// Application-only recovery: reuse proven Linux dependencies, never local node_modules.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

function run(command, args, cwd, code = "COMMAND_FAILED", privateLog) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    const error = new Error(code);
    if (privateLog) {
      writeFileSync(privateLog, (result.stdout || "") + (result.stderr || ""), { mode: 0o600 });
      error.privateLog = privateLog;
    }
    throw error;
  }
  return result.stdout.trim();
}
const git = (cwd, ...args) => run("git", args, cwd, "GIT_COMMAND_FAILED");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const jsonAt = (cwd, sha, path) => JSON.parse(git(cwd, "show", `${sha}:${path}`));
function versionOnly(cwd, base, target, path, key) {
  try {
    const a = jsonAt(cwd, base, path), b = jsonAt(cwd, target, path);
    delete a[key]; delete b[key];
    return JSON.stringify(a) === JSON.stringify(b);
  } catch { return false; }
}
function compiledOrDocumentation(path) {
  if (path.startsWith("deploy/")) return ["deploy/README.md", "deploy/AGENTS.md"].includes(path);
  if (path.startsWith("apps/dano/runtime/")) return false;
  return /^apps\/dano\/(src|types)\/.*\.ts$/.test(path)
    || path.startsWith("apps/dano/web/")
    || path.startsWith("docs/") || path.startsWith(".agents/")
    || /(?:^|\/)AGENTS\.md$/.test(path) || /\.md$/.test(path)
    || /(?:^|\/)__tests__\//.test(path) || /\.test\.[cm]?[jt]s$/.test(path);
}
export function planRuntimeArtifacts(cwd, base, target) {
  if (![base, target].every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error("FULL_COMMIT_SHA_REQUIRED");
  for (const sha of [base, target]) git(cwd, "cat-file", "-e", `${sha}^{commit}`);
  const changedPaths = git(cwd, "diff", "--name-only", base, target, "--").split("\n").filter(Boolean);
  const blockedPaths = changedPaths.filter(path => {
    if (path === "package.json") return !versionOnly(cwd, base, target, path, "version");
    if (path === "deploy/memory-release.json") return !versionOnly(cwd, base, target, path, "danoVersion");
    return !compiledOrDocumentation(path);
  });
  return { eligible: blockedPaths.length === 0, baseSha: base, targetSha: target, changedPaths, blockedPaths };
}
function cleanTarget(cwd, target) {
  if (git(cwd, "rev-parse", "HEAD") !== target || git(cwd, "status", "--porcelain", "--untracked-files=all")) {
    throw new Error("CLEAN_TARGET_CHECKOUT_REQUIRED");
  }
}
export function inventoryArtifacts(directory) {
  const files = [];
  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, 0o755);
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile() && stat.nlink === 1) {
      chmodSync(path, 0o644);
      files.push({ path: path.slice(directory.length + 1).split(sep).join("/"), sha256: hash(readFileSync(path)) });
    } else throw new Error("UNSAFE_ARTIFACT_TYPE");
  }
  visit(directory);
  return files;
}
export function buildRuntimeArtifacts(cwd, base, target, output) {
  cwd = realpathSync(cwd);
  const plan = planRuntimeArtifacts(cwd, base, target);
  if (!plan.eligible) throw new Error("RUNTIME_INPUTS_CHANGED");
  cleanTarget(cwd, target);
  output = join(realpathSync(dirname(resolve(output))), basename(resolve(output)));
  if (output === cwd || output.startsWith(cwd + sep) || existsSync(output)) throw new Error("NEW_EXTERNAL_OUTPUT_REQUIRED");
  if (existsSync(output + ".tar.gz")) throw new Error("ARCHIVE_EXISTS");
  // Reject an ABI mismatch before spending time on a build or a full test suite.
  try { createRequire(join(cwd, "apps/dano/package.json"))("fs-ext"); }
  catch { throw new Error("LOCAL_NODE_NATIVE_ABI_MISMATCH"); }
  const logDirectory = mkdtempSync(join(dirname(output), ".dano-artifact-build-"));
  chmodSync(logDirectory, 0o700);
  run("pnpm", ["run", "build"], cwd, "APPLICATION_BUILD_FAILED", join(logDirectory, "build.log"));
  rmSync(logDirectory, { recursive: true });
  cleanTarget(cwd, target);
  const dist = join(cwd, "apps/dano/dist");
  if (!existsSync(join(dist, "server/container-main.js")) || !existsSync(join(dist, "web/index.html"))) throw new Error("BUILD_OUTPUT_INCOMPLETE");
  // Validate before cpSync can dereference a link. Build output is public and disposable.
  inventoryArtifacts(dist);
  mkdirSync(output, { mode: 0o755 });
  cpSync(dist, join(output, "dist"), { recursive: true });
  writeFileSync(join(output, "product-package.json"), git(cwd, "show", `${target}:package.json`) + "\n");
  const files = inventoryArtifacts(output);
  const provenance = {
    ...plan, dependencyInputsUnchanged: true,
    sourceTree: git(cwd, "rev-parse", `${target}^{tree}`),
    version: jsonAt(cwd, target, "package.json").version, node: process.version,
    build: "pnpm run build", files,
  };
  writeFileSync(join(output, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n", { mode: 0o644 });
  writeFileSync(join(output, "Dockerfile.artifacts"), "ARG RUNTIME_BASE\nFROM ${RUNTIME_BASE}\nRUN rm -rf /app/dist\nCOPY dist/ /app/dist/\nCOPY product-package.json /app/package-versions/package.json\n", { mode: 0o644 });
  const archive = output + ".tar.gz";
  if (existsSync(archive)) throw new Error("ARCHIVE_EXISTS");
  run("tar", ["-czf", archive, "-C", output, "."], cwd, "ARCHIVE_FAILED");
  return { targetSha: target, baseSha: base, archive, sha256: hash(readFileSync(archive)), fileCount: files.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, base, target, output, ...extra] = process.argv.slice(2);
    if (extra.length || !["plan", "build"].includes(action) || (action === "build" ? !output : output)) throw new Error("USAGE_PLAN_OR_BUILD_BASE_TARGET_OUTPUT");
    const cwd = git(process.cwd(), "rev-parse", "--show-toplevel");
    const result = action === "plan" ? planRuntimeArtifacts(cwd, base, target) : buildRuntimeArtifacts(cwd, base, target, output);
    console.log(JSON.stringify(result));
    if (result.eligible === false) process.exitCode = 2;
  } catch (error) {
    const code = /^[A-Z][A-Z_]+$/.test(error.message) ? error.message : "ARTIFACT_PREPARATION_FAILED";
    console.error(JSON.stringify({ error: code, ...(error.privateLog ? { privateLog: error.privateLog } : {}) })); process.exitCode = 2;
  }
}
