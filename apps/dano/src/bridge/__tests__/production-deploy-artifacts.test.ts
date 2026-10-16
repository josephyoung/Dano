import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helper = await import(new URL("../../../../../.agents/skills/dano-production-deploy/scripts/runtime-artifacts.mjs", import.meta.url).href);
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dano-artifact-test-")); roots.push(root);
  const repo = join(root, "repo"); mkdirSync(repo);
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const put = (path: string, content: string) => {
    mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), content);
  };
  const commit = () => { git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "test(deploy): 验证产物边界"); return git("rev-parse", "HEAD"); };
  git("init", "-q");
  put(".gitignore", "node_modules\napps/dano/dist\n");
  put("package.json", '{"name":"fixture","version":"1.0.0","scripts":{"build":"fixture"}}');
  put("deploy/memory-release.json", '{"danoVersion":"1.0.0","dependency":"fixed"}');
  put("apps/dano/src/main.ts", "export const result = 'A';\n");
  const base = commit();
  return { root, repo, git, put, commit, base };
}

describe("application-only deployment artifacts", () => {
  it("allows compiled code with version metadata, while blocking changed runtime inputs", () => {
    const f = fixture();
    f.put("apps/dano/src/main.ts", "export const result = 'B';\n");
    f.put("package.json", '{"name":"fixture","version":"1.0.1","scripts":{"build":"fixture"}}');
    f.put("deploy/memory-release.json", '{"danoVersion":"1.0.1","dependency":"fixed"}');
    expect(helper.planRuntimeArtifacts(f.repo, f.base, f.commit())).toMatchObject({ eligible: true, blockedPaths: [] });
  });
  it.each(["Dockerfile", "pnpm-lock.yaml", "apps/dano/package.json", "apps/dano/runtime/system-prompt.mjs", "deploy/runtime-defaults/SYSTEM.md", "deploy/docker-entrypoint.sh", "scripts/build.mjs", "unknown.json"])("rejects changed %s", path => {
    const f = fixture(); f.put(path, "changed");
    expect(helper.planRuntimeArtifacts(f.repo, f.base, f.commit())).toMatchObject({ eligible: false, blockedPaths: [path] });
  });
  it("rejects root package script changes and memory dependency changes", () => {
    const f = fixture();
    f.put("package.json", '{"name":"fixture","version":"1.0.1","scripts":{"build":"different"}}');
    f.put("deploy/memory-release.json", '{"danoVersion":"1.0.1","dependency":"changed"}');
    expect(helper.planRuntimeArtifacts(f.repo, f.base, f.commit()).blockedPaths).toEqual(["deploy/memory-release.json", "package.json"]);
  });
  it("fails before build on dirty checkout, ABI failure or unsafe output destination", () => {
    const f = fixture();
    f.put("apps/dano/src/main.ts", "dirty");
    expect(() => helper.buildRuntimeArtifacts(f.repo, f.base, f.base, join(f.root, "out"))).toThrow("CLEAN_TARGET_CHECKOUT_REQUIRED");
    const target = f.commit();
    const alias = join(f.root, "repo-alias"); symlinkSync(f.repo, alias);
    expect(() => helper.buildRuntimeArtifacts(f.repo, f.base, target, join(alias, "out"))).toThrow("NEW_EXTERNAL_OUTPUT_REQUIRED");
    expect(() => helper.buildRuntimeArtifacts(f.repo, f.base, target, join(f.repo, "out"))).toThrow("NEW_EXTERNAL_OUTPUT_REQUIRED");
    const cli = spawnSync(process.execPath, [new URL("../../../../../.agents/skills/dano-production-deploy/scripts/runtime-artifacts.mjs", import.meta.url).pathname, "build", f.base, target, join(f.root, "out")], { cwd: f.repo, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } });
    expect(cli.status).toBe(2);
    expect(JSON.parse(cli.stderr)).toEqual({ error: "LOCAL_NODE_NATIVE_ABI_MISMATCH" });
    expect(existsSync(join(f.root, "out"))).toBe(false);
  });
  it("builds fresh output and packages source-bound hashes without copying dependencies", () => {
    const f = fixture(); f.put("apps/dano/src/main.ts", "export const result = 'B';\n");
    const target = f.commit();
    f.put("apps/dano/node_modules/fs-ext/index.js", "module.exports = {};\n");
    const bin = join(f.root, "bin"); mkdirSync(bin);
    const pnpm = join(bin, "pnpm");
    writeFileSync(pnpm, `#!${process.execPath}\nconst fs=require('node:fs');if(process.env.TEST_BUILD_FAIL==='1'){process.stderr.write('never-print-this');process.exit(7);}if(process.argv.slice(2).join(' ')!=='run build')process.exit(1);fs.mkdirSync('apps/dano/dist/server',{recursive:true});fs.mkdirSync('apps/dano/dist/web',{recursive:true});fs.writeFileSync('apps/dano/dist/server/container-main.js','fresh target output');fs.writeFileSync('apps/dano/dist/web/index.html','fresh target HTML');`);
    chmodSync(pnpm, 0o755);
    const previous = process.env.PATH; process.env.PATH = `${bin}:${previous}`;
    try {
      const output = join(f.root, "artifacts");
      const receipt = helper.buildRuntimeArtifacts(f.repo, f.base, target, output);
      expect(receipt).toMatchObject({ targetSha: target, baseSha: f.base, fileCount: 3 });
      const manifest = JSON.parse(readFileSync(join(output, "provenance.json"), "utf8"));
      expect(manifest).toMatchObject({ sourceTree: f.git("rev-parse", "HEAD^{tree}"), node: process.version });
      expect(manifest.files.some((entry: any) => entry.path.includes("node_modules"))).toBe(false);
      expect(readFileSync(join(output, "dist/server/container-main.js"), "utf8")).toBe("fresh target output");
      const archive = spawnSync("tar", ["-tzf", receipt.archive], { encoding: "utf8" });
      expect(archive.status).toBe(0);
      expect(archive.stdout).toContain("./provenance.json");
      expect(archive.stdout).toContain("./dist/server/container-main.js");
      const failure = spawnSync(process.execPath, [new URL("../../../../../.agents/skills/dano-production-deploy/scripts/runtime-artifacts.mjs", import.meta.url).pathname, "build", f.base, target, join(f.root, "failed-artifacts")], { cwd: f.repo, encoding: "utf8", env: { ...process.env, TEST_BUILD_FAIL: "1" } });
      expect(failure.status).toBe(2);
      expect(failure.stdout + failure.stderr).not.toContain("never-print-this");
      const error = JSON.parse(failure.stderr);
      expect(error.error).toBe("APPLICATION_BUILD_FAILED");
      expect(readFileSync(error.privateLog, "utf8")).toBe("never-print-this");
    } finally { process.env.PATH = previous; }
  });
  it("rejects a link before following or changing the external file", () => {
    const root = mkdtempSync(join(tmpdir(), "dano-artifact-links-")); roots.push(root);
    const dist = join(root, "dist"); mkdirSync(dist);
    const outside = join(root, "outside"); writeFileSync(outside, "private"); chmodSync(outside, 0o600);
    symlinkSync(outside, join(dist, "link"));
    expect(() => helper.inventoryArtifacts(dist)).toThrow("UNSAFE_ARTIFACT_TYPE");
    expect(readFileSync(outside, "utf8")).toBe("private");
  });
});
