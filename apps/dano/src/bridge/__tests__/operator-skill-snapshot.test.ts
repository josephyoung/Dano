import { afterEach, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotOperatorSkills } from "../operator-skill-snapshot.js";
const skill = (body: string) => `---\nname: custom\ndescription: Operator skill\n---\n${body}\n`;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "operator-skills-"))); roots.push(root);
  await mkdir(join(root, "installation"));
  await mkdir(join(root, "agent/skills/custom"), { recursive: true });
  return root;
}
it("retains operator skills and executable resources without publishing neighboring agent credentials", async () => {
  const root = await fixture();
  await writeFile(join(root, "agent/auth.json"), "private");
  await writeFile(join(root, "agent/skills/custom/SKILL.md"), skill("operator content"));
  await writeFile(join(root, "agent/skills/custom/run.sh"), "echo okay", { mode: 0o755 });
  const snapshot = await snapshotOperatorSkills(join(root, "installation"), [join(root, "agent/skills"), join(root, "missing")], process.getuid!());
  expect(snapshot.paths).toHaveLength(1);
  expect(await readFile(join(snapshot.paths[0]!, "custom/SKILL.md"), "utf8")).toBe(skill("operator content"));
  expect((await lstat(join(snapshot.paths[0]!, "custom/run.sh"))).mode & 0o777).toBe(0o555);
  await expect(lstat(join(snapshot.paths[0]!, "auth.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await snapshot.cleanup();
});
it("rejects links that could publish private files through a skill", async () => {
  const root = await fixture();
  await writeFile(join(root, "agent/auth.json"), "private");
  await symlink(join(root, "agent/auth.json"), join(root, "agent/skills/custom/secret"));
  await expect(snapshotOperatorSkills(join(root, "installation"), [join(root, "agent/skills")], process.getuid!())).rejects.toThrow("UNSAFE_OPERATOR_SKILL");
});

it("revokes a deleted skill in a running publication without a restart", async () => {
  const root = await fixture();
  const source = join(root, "agent/skills");
  await writeFile(join(source, "custom/SKILL.md"), skill("version A"));
  const snapshot = await snapshotOperatorSkills(join(root, "installation"), [source], process.getuid!());
  try {
    snapshot.setRevoker(async () => {});
    const oldPath = join(snapshot.paths[0]!, "custom/SKILL.md");
    await rm(join(source, "custom"), { recursive: true });
    await expect.poll(async () => {
      try { await readFile(oldPath); return true; }
      catch { return false; }
    }, { timeout: 3000 }).toBe(false);
  } finally { await snapshot.cleanup(); }
});

it("reconciles replacement, rename, same-path reinstall and all sources without watcher events", async () => {
  const root = await fixture(), source = join(root, "agent/skills"), other = join(root, "other");
  await mkdir(other);
  await writeFile(join(source, "custom/SKILL.md"), skill("A"));
  const publication = await snapshotOperatorSkills(join(root, "installation"), [source, other], process.getuid!());
  const revoked: string[][] = [];
  publication.setRevoker(async paths => { revoked.push([...paths]); });
  try {
    const first = await publication.refresh();
    await writeFile(join(source, "custom/SKILL.md"), skill("B"));
    const states = await Promise.all(Array.from({ length: 5 }, () => publication.refresh()));
    expect(new Set(states.map(state => state.revision)).size).toBe(1);
    expect(states[0]!.revision).toBe(first.revision + 2);
    await expect(readFile(join(first.paths[0]!, "custom/SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(states[0]!.paths[0]!, "custom/SKILL.md"), "utf8")).toBe(skill("B"));
    const { rename } = await import("node:fs/promises");
    await rename(join(source, "custom"), join(source, "renamed"));
    await mkdir(join(other, "added"));
    await writeFile(join(other, "added/SKILL.md"), skill("second source"));
    const renamed = await publication.refresh();
    expect(await readFile(join(renamed.paths[0]!, "renamed/SKILL.md"), "utf8")).toBe(skill("B"));
    expect(await readFile(join(renamed.paths[1]!, "added/SKILL.md"), "utf8")).toBe(skill("second source"));
    await mkdir(join(root, "replacement"));
    await writeFile(join(root, "replacement/SKILL.md"), skill("C"));
    await rename(join(source, "renamed"), join(root, "retired"));
    await rename(join(root, "replacement"), join(source, "renamed"));
    const replaced = await publication.refresh();
    expect(await readFile(join(replaced.paths[0]!, "renamed/SKILL.md"), "utf8")).toBe(skill("C"));
    await rm(join(source, "renamed"), { recursive: true });
    await publication.refresh();
    await mkdir(join(source, "renamed"));
    await writeFile(join(source, "renamed/SKILL.md"), skill("D"));
    const reinstalled = await publication.refresh();
    expect(await readFile(join(reinstalled.paths[0]!, "renamed/SKILL.md"), "utf8")).toBe(skill("D"));
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(root, "installation"))).toHaveLength(1);
    expect(revoked).toHaveLength(5);
  } finally { await publication.cleanup(); }
});

it.each(["symlink", "hardlink", "permissions"])("revokes unsafe %s updates and recovers without old-version fallback", async kind => {
  const root = await fixture(), source = join(root, "agent/skills");
  await writeFile(join(source, "custom/SKILL.md"), skill("safe A"));
  await writeFile(join(root, "agent/private"), "private");
  const publication = await snapshotOperatorSkills(join(root, "installation"), [source], process.getuid!());
  try {
    const previous = [...publication.paths];
    const { link, chmod } = await import("node:fs/promises");
    const bad = join(source, "custom/unsafe");
    if (kind === "symlink") await symlink(join(root, "agent/private"), bad);
    else if (kind === "hardlink") await link(join(root, "agent/private"), bad);
    else { await writeFile(bad, "bad"); await chmod(bad, 0o666); }
    const state = await publication.refresh();
    expect(state).toMatchObject({ paths: [], error: "UNSAFE_OPERATOR_SKILL" });
    await expect(lstat(previous[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(bad);
    await writeFile(join(source, "custom/SKILL.md"), skill("safe B"));
    const recovered = await publication.refresh();
    expect(recovered.error).toBeUndefined();
    expect(await readFile(join(recovered.paths[0]!, "custom/SKILL.md"), "utf8")).toBe(skill("safe B"));
  } finally { await publication.cleanup(); }
});

it("removes only reserved obsolete publications under the supervisor startup lock", async () => {
  const root = await fixture(), installation = join(root, "installation");
  await mkdir(join(installation, ".operator-skills-aBc123"));
  await writeFile(join(installation, ".operator-skills-aBc123/old"), "old");
  await mkdir(join(installation, ".operator-skills-operator-notes"));
  const publication = await snapshotOperatorSkills(installation, [join(root, "agent/skills")], process.getuid!());
  try {
    await publication.cleanupStale();
    await expect(lstat(join(installation, ".operator-skills-aBc123"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(join(installation, ".operator-skills-operator-notes"))).isDirectory()).toBe(true);
    expect((await lstat(publication.paths[0]!)).isDirectory()).toBe(true);
  } finally { await publication.cleanup(); }
});

it("rejects a malformed replacement rather than leaving its old script executable", async () => {
  const root = await fixture(), source = join(root, "agent/skills");
  await writeFile(join(source, "custom/SKILL.md"), skill("A"));
  await writeFile(join(source, "custom/run.sh"), "echo A", { mode: 0o755 });
  const publication = await snapshotOperatorSkills(join(root, "installation"), [source], process.getuid!());
  try {
    const old = join(publication.paths[0]!, "custom/run.sh");
    await writeFile(join(source, "custom/SKILL.md"), "---\nname: [invalid\n---\n");
    expect(await publication.refresh()).toMatchObject({ paths: [], error: "UNSAFE_OPERATOR_SKILL" });
    await expect(lstat(old)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await publication.cleanup(); }
});

it("makes retired absolute script paths fail actual execution after replacement and deletion", async () => {
  const root = await fixture(), source = join(root, "agent/skills");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execute = promisify(execFile);
  await writeFile(join(source, "custom/SKILL.md"), skill("Execute run.sh"));
  await writeFile(join(source, "custom/run.sh"), "printf VERSION_A", { mode: 0o755 });
  const publication = await snapshotOperatorSkills(join(root, "installation"), [source], process.getuid!());
  try {
    const old = join(publication.paths[0]!, "custom/run.sh");
    expect((await execute("/bin/sh", [old])).stdout).toBe("VERSION_A");
    await writeFile(join(source, "custom/run.sh"), "printf VERSION_B");
    await publication.refresh();
    await expect(execute("/bin/sh", [old])).rejects.toThrow();
    const current = join(publication.paths[0]!, "custom/run.sh");
    expect((await execute("/bin/sh", [current])).stdout).toBe("VERSION_B");
    await rm(join(source, "custom"), { recursive: true }); await publication.refresh();
    await expect(execute("/bin/sh", [current])).rejects.toThrow();
  } finally { await publication.cleanup(); }
});
