import { afterEach, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import product from "../../../../../dano.config.json" with { type: "json" };
import { loadEffectiveMemoryConfig, memoryTokenizerBinding, parseMemorySecrets, readMemorySecrets,
  resolveMemoryConfig, type MemoryModelRuntime } from "../effective-memory-config.js";
import { projectMemoryModels } from "../memory-model-projection.js";

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const secrets = { accountId: "account", managementKey: "synthetic-management", encryptionKey: "ab".repeat(32), encryptionKeyVersion: "v1" };
const globalSettings = { defaultProvider: "xiaomi", defaultModel: "mimo-v2.6-flash", defaultThinkingLevel: "off" };
function fixture() {
  const models = [
    { provider: "xiaomi", id: "mimo-v2.6-flash", api: "openai-completions", baseUrl: "https://api.xiaomimimo.com/v1", reasoning: true, thinkingLevelMap: { off: "off", minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null }, compat: { supportsReasoningEffort: false } },
    { provider: "deepseek", id: "deepseek-flash", api: "openai-completions", baseUrl: "https://api.deepseek.com", reasoning: true },
  ];
  const auth = vi.fn(async () => ({ auth: { apiKey: "synthetic-provider-key" } }));
  const runtime = { getModel: (provider: string, id: string) => models.find(model => model.provider === provider && model.id === id),
    getModels: () => models, getAuth: auth } as unknown as MemoryModelRuntime;
  const options = { ...structuredClone(product.openVikingSettings), enabled: true };
  return { models, runtime, options, auth };
}
it("derives collection/extraction/auth from global defaults and keeps a separate receiving-model tokenizer", async () => {
  const f = fixture();
  const config = await resolveMemoryConfig(globalSettings, f.options, secrets, f.runtime, "/assets");
  expect(config.collection?.model).toMatchObject({ provider: "xiaomi", id: "mimo-v2.6-flash", thinking: "disabled" });
  expect(config.tokenizers.map(binding => binding.model.id)).toEqual(["mimo-v2.6-flash", "deepseek-flash"]);
  const projected = projectMemoryModels(config, { vlm: { credentials: ["stale"], backup: { model: "stale" }, extra_request_body: { stale: true } } }, "");
  expect(projected.openViking.vlm).toMatchObject({ model: "mimo-v2.6-flash", api_key: "synthetic-provider-key", thinking: false,
    extra_request_body: { thinking: { type: "disabled" } } });
  expect(projected.openViking.vlm).not.toHaveProperty("credentials");
  expect(projected.openViking.vlm).not.toHaveProperty("backup");
  expect(projected.env).not.toContain("synthetic-provider-key");
  const switched = await resolveMemoryConfig({ defaultProvider: "deepseek", defaultModel: "deepseek-flash", defaultThinkingLevel: "high" }, f.options, secrets, f.runtime, "/assets");
  expect(switched.collection?.model).toMatchObject({ provider: "deepseek", id: "deepseek-flash", reasoning: "high" });
  expect(switched.deployment?.extraction.api_base).toBe("https://api.deepseek.com");
  expect(f.auth).toHaveBeenLastCalledWith(f.models[1]);
  expect(config.collection?.model.id).toBe("mimo-v2.6-flash");
});
it("rejects unsupported model thinking levels and follows the provider-native effort contract", async () => {
  const f = fixture();
  await expect(resolveMemoryConfig({ ...globalSettings, defaultThinkingLevel: "medium" }, f.options, secrets, f.runtime, "/assets"))
    .rejects.toThrow("model:UNSUPPORTED_MEMORY_THINKING");
  const high = await resolveMemoryConfig({ ...globalSettings, defaultThinkingLevel: "high" }, f.options, secrets, f.runtime, "/assets");
  expect(high.collection?.model.reasoning).toBe("high");
  expect(projectMemoryModels(high, {}, "").openViking.vlm).toMatchObject({ extra_request_body: { thinking: { type: "enabled" } } });
  expect((projectMemoryModels(high, {}, "").openViking.vlm as any).extra_request_body).not.toHaveProperty("reasoning_effort");
});
it("rejects duplicate model/key/tokenizer configuration instead of accepting a second authority", async () => {
  const f = fixture();
  for (const override of [{ memoryModel: {} }, { tokenizers: [] }, { apiKey: "SENSITIVE_INPUT" }, { collection: { ...f.options.collection, model: {} } }]) {
    await expect(resolveMemoryConfig(globalSettings, { ...f.options, ...override }, secrets, f.runtime, "/assets"))
      .rejects.toThrow("settings:INVALID_OPENVIKING_SETTINGS");
  }
  expect(() => parseMemorySecrets({ ...secrets, baseUrl: "https://other.test" })).toThrow("INVALID_MEMORY_SECRETS");
});
it("provides safe, distinct startup diagnostics for settings, model and auth failures", async () => {
  const f = fixture();
  await expect(resolveMemoryConfig({ ...globalSettings, defaultThinkingLevel: "立即回答" }, f.options, secrets, f.runtime, "/assets")).rejects.toThrow("settings:INVALID_GLOBAL_MEMORY_MODEL");
  await expect(resolveMemoryConfig({ ...globalSettings, defaultModel: "unknown" }, f.options, secrets, f.runtime, "/assets")).rejects.toThrow("model:UNKNOWN_MEMORY_MODEL");
  f.models[0]!.baseUrl = "https://unverified-proxy.test";
  await expect(resolveMemoryConfig(globalSettings, f.options, secrets, f.runtime, "/assets")).rejects.toThrow("tokenizer:UNSUPPORTED_MEMORY_MODEL");
  f.models[0]!.baseUrl = "https://api.xiaomimimo.com/v1";
  f.auth.mockRejectedValue(new Error("SENSITIVE_PROVIDER_RESPONSE"));
  await expect(resolveMemoryConfig(globalSettings, f.options, secrets, f.runtime, "/assets")).rejects.toThrow(/^credentials:MEMORY_PROVIDER_AUTH_UNAVAILABLE$/);
  f.auth.mockResolvedValue({ auth: { apiKey: "" } });
  await expect(resolveMemoryConfig(globalSettings, f.options, secrets, f.runtime, "/assets")).rejects.toThrow("credentials:MEMORY_PROVIDER_API_KEY_REQUIRED");
});
it("loads only global settings, snapshots them until restart, and never reads legacy private config", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "memory-effective-"))); roots.push(root);
  const agent = join(root, "agent"); await mkdir(agent, { mode: 0o700 });
  await writeFile(join(root, "memory-secrets.json"), JSON.stringify(secrets), { mode: 0o600 });
  const f = fixture();
  const configPath = join(root, "dano.config.json"); await writeFile(configPath, JSON.stringify({ openVikingSettings: f.options }));
  vi.stubEnv("DANO_CONFIG_PATH", configPath);
  await writeFile(join(agent, "settings.json"), JSON.stringify(globalSettings));
  await mkdir(join(root, ".pi")); await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ ...globalSettings, defaultModel: "workspace-model" }));
  await writeFile(join(root, "memory-service.json"), "CORRUPT_LEGACY_CONFIG");
  const before = await loadEffectiveMemoryConfig(root, agent, f.runtime);
  await writeFile(join(agent, "settings.json"), JSON.stringify({ ...globalSettings, defaultProvider: "deepseek", defaultModel: "deepseek-flash" }));
  expect(before?.collection?.model.id).toBe("mimo-v2.6-flash");
  expect((await loadEffectiveMemoryConfig(root, agent, f.runtime))?.collection?.model.id).toBe("deepseek-flash");
  expect(await readFile(join(root, "memory-service.json"), "utf8")).toBe("CORRUPT_LEGACY_CONFIG");
  await chmod(join(root, "memory-secrets.json"), 0o644);
  await expect(readMemorySecrets(root)).rejects.toThrow("secrets:INVALID_MEMORY_SECRETS");
  await rm(join(root, "memory-secrets.json")); await symlink(join(agent, "settings.json"), join(root, "memory-secrets.json"));
  await expect(readMemorySecrets(root)).rejects.toThrow("secrets:INVALID_MEMORY_SECRETS");
});
it("does not guess tokenizer compatibility from model names or relabel global assets", () => {
  const f = fixture();
  expect(() => memoryTokenizerBinding({ ...f.models[0]!, id: "mimo-v2.6-pro" }, "/assets")).toThrow("UNSUPPORTED_MEMORY_MODEL");
  expect(memoryTokenizerBinding(f.models[0]!, "/assets").tokenizer.sha256)
    .not.toBe(memoryTokenizerBinding(f.models[1]!, "/assets").tokenizer.sha256);
});
