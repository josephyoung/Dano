#!/usr/bin/env node
// Run from the built image as the private configuration owner. Never log config.
import { lstat, readFile, rename, writeFile, unlink, chown, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

try {
  const [mode, configDirectory, ovPath, envPath] = process.argv.slice(2);
  if (!configDirectory || (mode === "preflight" ? process.argv.length !== 4
    : !["check", "sync"].includes(mode) || !ovPath || !envPath || process.argv.length !== 6)) throw Error();
  const built = resolve("dist/server/bridge");
  const { loadEffectiveMemoryConfig, createGlobalMemoryModelRuntime } = await import(pathToFileURL(join(built, "effective-memory-config.js")).href);
  const { MemoryTokenizers } = await import(pathToFileURL(join(built, "memory-tokenizer.js")).href);
  const agentDirectory = process.env.PI_CODING_AGENT_DIR;
  if (!agentDirectory) throw Error("GLOBAL_AGENT_DIRECTORY_REQUIRED");
  const { projectMemoryModels } = await import(pathToFileURL(join(built, "memory-model-projection.js")).href);
  const runtime = await createGlobalMemoryModelRuntime(agentDirectory);
  const config = await loadEffectiveMemoryConfig(configDirectory, agentDirectory, runtime);
  if (!config) throw Error("MEMORY_DISABLED");
  const tokenizers = await MemoryTokenizers.create(config.tokenizers, config.tokenizerLimits);
  await tokenizers.close();
  if (mode === "preflight") { console.log("MEMORY_CONFIG_VALID"); process.exit(0); }
  const inputs = await Promise.all([ovPath, envPath].map(async path => {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077)
      || (process.getuid?.() !== 0 && stat.uid !== process.getuid?.())
      || await realpath(path) !== resolve(path)) throw Error();
    return { path, stat, text: await readFile(path, "utf8") };
  }));
  const ov = JSON.parse(inputs[0].text);
  const projected = projectMemoryModels(config, ov, inputs[1].text);
  const contents = [JSON.stringify(projected.openViking, null, 2) + "\n", projected.env];
  if (mode === "check") {
    if (JSON.stringify(ov) !== JSON.stringify(projected.openViking) || inputs[1].text !== projected.env) throw Error();
  } else {
    // Validate all inputs before either atomic replacement. A failed interrupted
    // sync cannot pass the required check before Compose starts.
    for (let i = 0; i < contents.length; i++) {
      const input = inputs[i], temp = `${input.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, contents[i], { flag: "wx", mode: input.stat.mode & 0o777 });
        if (process.getuid?.() === 0) await chown(temp, input.stat.uid, input.stat.gid);
        await rename(temp, input.path);
      } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    }
  }
  console.log(mode === "check" ? "MEMORY_MODELS_MATCH" : "MEMORY_MODELS_PROJECTED");
} catch (error) {
  const { MemoryConfigurationError } = await import("../dist/server/bridge/effective-memory-config.js");
  console.error(error instanceof MemoryConfigurationError ? error.message : "MEMORY_MODEL_PROJECTION_FAILED");
  process.exitCode = 1;
}
