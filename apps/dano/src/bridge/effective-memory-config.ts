import { readFile, lstat, realpath, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseMemoryHostConfig, type MemoryHostConfig } from "./memory-host-config.js";
import { loadDanoConfig } from "./dano-config.js";
import catalog from "./tokenizer-catalog.json" with { type: "json" };
import type { MemoryModelIdentity, MemoryTokenizerBinding } from "./memory-tokenizer.js";

export class MemoryConfigurationError extends Error {
  constructor(readonly stage: string, readonly code: string) { super(`${stage}:${code}`); }
}
const fail = (stage: string, code: string): never => { throw new MemoryConfigurationError(stage, code); };
export type MemoryModelRuntime = Pick<ModelRuntime, "getModel" | "getModels" | "getAuth" | "completeSimple">;
export interface MemorySecrets { accountId: string; managementKey: string; encryptionKey: string; encryptionKeyVersion: string }

export function parseMemorySecrets(input: unknown): MemorySecrets {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("secrets", "INVALID_MEMORY_SECRETS");
  const raw = input as Record<string, unknown>;
  const keys = ["accountId", "managementKey", "encryptionKey", "encryptionKeyVersion"];
  if (Object.keys(raw).length !== keys.length || keys.some(key => typeof raw[key] !== "string" || !raw[key])
    || !/^[A-Za-z0-9_-]{1,128}$/.test(String(raw.accountId))
    || !/^[A-Za-z0-9_-]{1,128}$/.test(String(raw.encryptionKeyVersion))
    || !/^[a-fA-F0-9]{64}$/.test(String(raw.encryptionKey)) || /\s/.test(String(raw.managementKey))) {
    return fail("secrets", "INVALID_MEMORY_SECRETS");
  }
  return raw as unknown as MemorySecrets;
}

/** Secret-only input; model, policy and tokenizer fields are rejected. */
export async function readMemorySecrets(directory: string): Promise<MemorySecrets> {
  try {
    const stat = await lstat(directory);
    const owner = process.getuid?.() === 0 && /^[1-9][0-9]*$/.test(process.env.DANO_HOST_UID ?? "")
      ? Number(process.env.DANO_HOST_UID) : process.getuid?.();
    if (await realpath(directory) !== resolve(directory) || !stat.isDirectory() || stat.uid !== owner
      || (stat.mode & 0o077)) throw Error();
    const file = await open(join(directory, "memory-secrets.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== owner || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > 65536) throw Error();
      const bytes = await file.readFile();
      if (bytes.length > 65536) throw Error();
      return parseMemorySecrets(JSON.parse(bytes.toString("utf8")));
    } finally { await file.close(); }
  } catch { return fail("secrets", "INVALID_MEMORY_SECRETS"); }
}

/** The catalog is release-owned provenance, never an operator model binding. */
export function memoryTokenizerBinding(model: MemoryModelIdentity & { baseUrl: string }, directory: string): MemoryTokenizerBinding {
  const entry = catalog.find(entry => entry.models.includes(model.id) && entry.origins.includes(new URL(model.baseUrl).origin));
  if (!entry || model.api !== "openai-completions") return fail("tokenizer", "UNSUPPORTED_MEMORY_MODEL");
  return { model: { provider: model.provider, api: model.api, id: model.id },
    tokenizer: { path: join(directory, entry.revision, "tokenizer.json"), sha256: entry["tokenizer.json"] },
    config: { path: join(directory, entry.revision, "tokenizer_config.json"), sha256: entry["tokenizer_config.json"] } };
}

/** Pure resolution: only global settings are accepted, never a workspace SettingsManager. */
export async function resolveMemoryConfig(settings: Record<string, unknown>, options: Record<string, unknown>, secrets: MemorySecrets,
  runtime: MemoryModelRuntime, assetDirectory: string): Promise<MemoryHostConfig> {
  const fields = ["enabled", "baseUrl", "requestTimeoutMs", "maxContentBytes", "policyVersion", "policy", "reranker", "scheduler", "tokenizerLimits", "collection", "embedding", "generation"];
  if (options.enabled !== true || Object.keys(options).some(key => !fields.includes(key))) return fail("settings", "INVALID_OPENVIKING_SETTINGS");
  const { defaultProvider, defaultModel, defaultThinkingLevel } = settings;
  if (typeof defaultProvider !== "string" || typeof defaultModel !== "string"
    || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(defaultThinkingLevel))) {
    return fail("settings", "INVALID_GLOBAL_MEMORY_MODEL");
  }
  const model = runtime.getModel(defaultProvider, defaultModel);
  if (!model) return fail("model", "UNKNOWN_MEMORY_MODEL");
  const binding = memoryTokenizerBinding(model, assetDirectory);
  if (defaultThinkingLevel !== "off" && !model.reasoning) return fail("model", "UNSUPPORTED_MEMORY_THINKING");
  let auth;
  try { auth = await runtime.getAuth(model); }
  catch { return fail("credentials", "MEMORY_PROVIDER_AUTH_UNAVAILABLE"); }
  // The OpenViking OpenAI adapter needs an API key. Header-only/OAuth adapters
  // must gain an explicit compatible projection before they can be activated.
  if (!auth?.auth.apiKey || Object.keys(auth.auth.headers ?? {}).length) return fail("credentials", "MEMORY_PROVIDER_API_KEY_REQUIRED");
  const { enabled: _enabled, generation, ...functional } = options;
  if (!generation || typeof generation !== "object" || Array.isArray(generation)
    || Object.keys(generation).some(key => !["maxTokens", "temperature"].includes(key))) return fail("settings", "INVALID_OPENVIKING_SETTINGS");
  let config;
  try {
    config = parseMemoryHostConfig({ ...functional, version: 2, ...secrets,
      memoryModel: { ...binding.model, tokenizer: binding.tokenizer, config: binding.config,
        generation: { ...generation, thinking: defaultThinkingLevel === "off" ? "disabled" : "enabled" },
        extraction: { provider: "openai", apiBase: model.baseUrl, apiKey: auth.auth.apiKey } } });
  } catch { return fail("settings", "INVALID_OPENVIKING_SETTINGS"); }
  if (config.collection) config.collection.model.reasoning = defaultThinkingLevel === "off" ? undefined : defaultThinkingLevel as NonNullable<typeof config.collection.model.reasoning>;
  config.deployment!.thinking = defaultThinkingLevel === "off" ? "disabled" : "enabled";
  config.deployment!.reasoning = defaultThinkingLevel === "off" ? undefined : String(defaultThinkingLevel);
  config.deployment!.generation = { maxTokens: config.collection?.model.maxTokens ?? Number((generation as Record<string, unknown>).maxTokens),
    temperature: Number((generation as Record<string, unknown>).temperature) };
  // All supported receiving models get their own exact binding. No default-
  // model fallback is used for a session's temporary model selection.
  config.tokenizers = runtime.getModels().flatMap(model => {
    try { return [memoryTokenizerBinding(model, assetDirectory)]; }
    catch (error) { if (error instanceof MemoryConfigurationError) return []; throw error; }
  });
  if (!config.tokenizers.some(entry => entry.model.provider === model.provider && entry.model.id === model.id)) config.tokenizers.push(binding);
  return config;
}

export async function loadEffectiveMemoryConfig(directory: string, agentDirectory: string, runtime: MemoryModelRuntime): Promise<MemoryHostConfig | undefined> {
  const options = loadDanoConfig().openVikingSettings;
  if (options?.enabled === false) return undefined;
  if (options?.enabled !== true) return fail("settings", "INVALID_OPENVIKING_SETTINGS");
  let settings;
  try { settings = JSON.parse(await readFile(join(agentDirectory, "settings.json"), "utf8")); }
  catch { return fail("settings", "INVALID_GLOBAL_MEMORY_SETTINGS"); }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return fail("settings", "INVALID_GLOBAL_MEMORY_SETTINGS");
  return resolveMemoryConfig(settings, options, await readMemorySecrets(directory), runtime, join(directory, "tokenizers"));
}

export { catalog as memoryTokenizerCatalog };

export async function createGlobalMemoryModelRuntime(agentDirectory: string): Promise<ModelRuntime> {
  return ModelRuntime.create({ authPath: join(agentDirectory, "auth.json"), modelsPath: join(agentDirectory, "models.json"),
    refreshOnCreate: false, allowModelNetwork: false });
}

/** Recovery/key maintenance needs service location and existing encryption
 * material, never an inference model or a second copy of functional settings. */
export async function loadMemoryManagementConfig(directory: string) {
  const options = loadDanoConfig().openVikingSettings;
  try {
    if (!options || typeof options.baseUrl !== "string" || typeof options.requestTimeoutMs !== "number"
      || !Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0) throw Error();
    const url = new URL(options.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error();
    return { ...await readMemorySecrets(directory), baseUrl: url.origin, requestTimeoutMs: options.requestTimeoutMs };
  } catch (error) {
    if (error instanceof MemoryConfigurationError) throw error;
    return fail("settings", "INVALID_MEMORY_MANAGEMENT_CONFIG");
  }
}
