import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const OPERATOR_SKILL_POLL_MS = 1000;
export const OPERATOR_SKILL_SCAN_MS = 2000;
export const OPERATOR_SKILL_PUBLISH_MS = 2000;
const unsafe = () => new Error("UNSAFE_OPERATOR_SKILL");
type Tree = { mode: number; children: Map<string, Tree> } | { mode: number; bytes: Buffer };
export interface OperatorSkillRevision { revision: number; paths: string[]; error?: string }
export interface OperatorSkills {
  readonly paths: string[];
  refresh(): Promise<OperatorSkillRevision>;
  /** Called before old resources are removed. Must terminate all old workers. */
  cleanupStale(): Promise<void>;
  setRevoker(revoke: (paths: readonly string[]) => Promise<void>): void;
  subscribe(listener: (state: OperatorSkillRevision) => void): () => void;
  cleanup(): Promise<void>;
}

/** Reconcile complete trees, rather than trusting watcher events. Immutable,
 * unique generation paths prevent historical references authorizing a new version.
 * No neighboring agent configuration is ever published. */
export async function snapshotOperatorSkills(installation: string, sources: readonly string[], hostUid: number): Promise<OperatorSkills> {
  const roots = [...new Set(sources.map(path => resolve(path)))];
  const paths: string[] = [];
  const listeners = new Set<(state: OperatorSkillRevision) => void>();
  let current: string | undefined;
  let fingerprint: string | undefined;
  let rejectedFingerprint: string | undefined;
  let revision = 0;
  let error: string | undefined;
  let closed = false;
  let pending: Promise<OperatorSkillRevision> | undefined;
  let revoker: (paths: readonly string[]) => Promise<void> = async () => {};
  const capture = async (): Promise<{ trees: Map<number, Tree>; hash: string }> => {
    const hash = createHash("sha256");
    const read = async (path: string): Promise<Tree> => {
      const stat = await lstat(path);
      if (![0, hostUid].includes(stat.uid) || (stat.mode & 0o022) || (!stat.isDirectory() && !stat.isFile())) throw unsafe();
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (stat.isDirectory() ? constants.O_DIRECTORY : 0));
      try {
        const before = await handle.stat();
        if (before.ino !== stat.ino || before.dev !== stat.dev || before.mode !== stat.mode || before.uid !== stat.uid
          || (before.isFile() && before.nlink !== 1)) throw unsafe();
        hash.update(JSON.stringify([before.mode, before.uid, before.ino, before.dev, before.size, before.mtimeMs, before.ctimeMs]));
        let tree: Tree;
        if (before.isDirectory()) {
          const children = new Map<string, Tree>();
          // Linux open directory descriptors anchor traversal against rename and
          // symlink swaps. The portable path is also checked after traversal.
          const directory = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : path;
          for (const name of (await readdir(directory)).sort()) {
            hash.update(JSON.stringify(name));
            children.set(name, await read(join(directory, name)));
          }
          tree = { mode: 0o755, children };
        } else {
          const bytes = await handle.readFile();
          hash.update(bytes);
          tree = { mode: (before.mode & 0o111) ? 0o555 : 0o444, bytes };
        }
        const after = await handle.stat(), named = await lstat(path);
        if (after.ino !== named.ino || after.dev !== named.dev || after.mode !== before.mode || after.uid !== before.uid
          || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || (after.isFile() && after.nlink !== 1)) throw unsafe();
        return tree;
      } finally { await handle.close(); }
    };
    const trees = new Map<number, Tree>();
    for (const [index, source] of roots.entries()) {
      hash.update(JSON.stringify([index, source]));
      try { await lstat(source); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code === "ENOENT") { hash.update("missing"); continue; } throw failure; }
      if (await realpath(source) !== source || !(await lstat(source)).isDirectory()) throw unsafe();
      trees.set(index, await read(source));
      if (await realpath(source) !== source) throw unsafe();
    }
    return { trees, hash: hash.digest("hex") };
  };
  const publish = async (trees: Map<number, Tree>) => {
    const directory = await mkdtemp(join(installation, ".operator-skills-"));
    const write = async (path: string, tree: Tree): Promise<void> => {
      if ("children" in tree) {
        await mkdir(path, { mode: 0o700 });
        for (const [name, child] of tree.children) await write(join(path, name), child);
        await chmod(path, tree.mode);
      } else await writeFile(path, tree.bytes, { flag: "wx", mode: tree.mode });
    };
    try {
      for (const [index, tree] of trees) await write(join(directory, String(index)), tree);
      for (const index of trees.keys()) {
        const result = loadSkillsFromDir({ dir: join(directory, String(index)), source: "path" });
        const loaded = new Set(result.skills.map(skill => skill.filePath));
        // Pi intentionally accepts advisory name warnings. Reject resources it
        // cannot load at all, so malformed replacements cannot retain authority.
        if (result.diagnostics.some(diagnostic => diagnostic.path && !loaded.has(diagnostic.path))) throw unsafe();
      }
      await chmod(directory, 0o755);
      return { directory, paths: [...trees.keys()].map(index => join(directory, String(index))) };
    } catch (failure) { await rm(directory, { recursive: true, force: true }); throw failure; }
  };
  const state = (): OperatorSkillRevision => ({ revision, paths: [...paths], ...(error ? { error } : {}) });
  const reconcile = async () => {
    let captured: Awaited<ReturnType<typeof capture>> | undefined;
    let nextError: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      captured = await Promise.race([(async () => {
        const first = await capture();
        if (first.hash === fingerprint || first.hash === rejectedFingerprint) return first;
        const second = await capture();
        if (second.hash !== first.hash) throw unsafe();
        return first;
      })(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(unsafe()), OPERATOR_SKILL_SCAN_MS);
      })]);
      if (captured.hash === fingerprint || captured.hash === rejectedFingerprint) return state();
    } catch { captured = undefined; nextError = "UNSAFE_OPERATOR_SKILL"; }
    finally { if (timer) clearTimeout(timer); }
    if (closed) return state();
    if (nextError && error === nextError && !paths.length) return state();
    let next: Awaited<ReturnType<typeof publish>> | undefined;
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    let abandoned = false;
    try {
      if (captured) next = await Promise.race([publish(captured.trees).then(async value => {
        if (abandoned) await rm(value.directory, { recursive: true, force: true });
        return value;
      }), new Promise<never>((_, reject) => {
        publishTimer = setTimeout(() => { abandoned = true; reject(unsafe()); }, OPERATOR_SKILL_PUBLISH_MS);
      })]);
    } catch (failure) {
      if (!abandoned && failure instanceof Error && failure.message === "UNSAFE_OPERATOR_SKILL") {
        rejectedFingerprint = captured?.hash;
      }
      captured = undefined; nextError = "UNSAFE_OPERATOR_SKILL";
    }
    finally { if (publishTimer) clearTimeout(publishTimer); }
    // Invalidate discovery before waiting for process shutdown or disk cleanup.
    // A second revision below announces the complete replacement publication.
    paths.splice(0);
    revision++;
    for (const listener of listeners) listener(state());
    try {
      // Removal of slots precedes publication. Old mounts/processes must be gone
      // before cleanup and before an RPC can observe the new revision.
      await revoker(next?.paths ?? []);
      if (current) await rm(current, { recursive: true, force: true });
      current = next?.directory;
      paths.splice(0, paths.length, ...(next?.paths ?? []));
      fingerprint = captured?.hash;
      if (captured) rejectedFingerprint = undefined;
      error = nextError;
      if (error) console.warn("[dano] Administrator skills unavailable: UNSAFE_OPERATOR_SKILL");
      revision++;
      for (const listener of listeners) listener(state());
      return state();
    } catch (failure) {
      if (next) await rm(next.directory, { recursive: true, force: true });
      throw failure;
    }
  };
  const refresh = () => {
    if (closed) return Promise.reject(new Error("OPERATOR_SKILLS_CLOSED"));
    pending ??= reconcile().finally(() => { pending = undefined; });
    return pending;
  };
  await refresh();
  if (error) { if (current) await rm(current, { recursive: true, force: true }); throw unsafe(); }
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    paths, refresh,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async cleanupStale() {
      await pending;
      for (const name of await readdir(installation)) {
        if (!/^\.operator-skills-[A-Za-z0-9]{6}$/.test(name)) continue;
        const path = join(installation, name);
        if (path === current) continue;
        const metadata = await lstat(path);
        if (!metadata.isDirectory() || metadata.uid !== (process.getuid?.() ?? 0)) throw unsafe();
        await rm(path, { recursive: true, force: true });
      }
    },
    setRevoker(revoke) {
      revoker = revoke;
      timer ??= setInterval(() => { void refresh().catch(() => { /* RPC retries fail closed. */ }); }, OPERATOR_SKILL_POLL_MS);
      timer.unref();
    },
    async cleanup() {
      closed = true;
      clearInterval(timer);
      await pending;
      if (current) await rm(current, { recursive: true, force: true });
    },
  };
}
