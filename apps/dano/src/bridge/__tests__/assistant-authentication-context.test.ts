import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { CredentialBroker } from "../credential-broker.js";
import { createDetachedAgentSessionRuntime } from "../detached-session.js";

it.each([false, true])("projects the initiating connection's login status without credentials or stale history (protected=%s)", async protectedRuntime => {
  const root = await mkdtemp(join(tmpdir(), "dano-auth-context-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  const provider = fauxProvider({ provider: "authentication-context" });
  const received: string[] = [];
  const record = (context: { messages: unknown[] }) => {
    received.push(JSON.stringify(context.messages));
    return fauxAssistantMessage("done");
  };
  provider.setResponses([record, record, record, record]);
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  models.registerNativeProvider(provider.provider);
  await models.setRuntimeApiKey(provider.provider.id, "test-only");
  const readCredential = vi.fn(async () => ({ accessToken: "private-token" }));
  const broker = new CredentialBroker({ providerApiOrigin: "https://provider.test", readCredential });
  let result: Awaited<ReturnType<typeof createDetachedAgentSessionRuntime>> | undefined;
  try {
    result = await createDetachedAgentSessionRuntime(workspace, SessionManager.inMemory(workspace), {
      modelRuntime: models, settingsManager: SettingsManager.inMemory(), model: provider.getModel(),
      thinkingLevel: "off", credentialBroker: broker, credentialBrokerScope: "test-user",
      ...(protectedRuntime ? { protectedTools: {
        agentDir, trustedSkillPaths: [], providerPythonModuleDirectory: join(root, "python"),
        // A routing double; kernel isolation is covered by the deployment preflight.
        resolveWorker: async () => ({ workspace, assertIsolated: async () => {},
          execute: async () => ({ content: [] }) }),
      } } : {}),
    });
    const session = result.runtime.session;
    broker.queueAssistantTurn("test-user", session.sessionId, undefined, "anonymous");
    await session.prompt("First request");
    expect(received[0]).toContain("Dano trusted authentication status: anonymous");
    broker.queueAssistantTurn("test-user", session.sessionId, "private-login-id", "authenticated");
    await session.prompt("My business script reports a missing token");
    expect(received[1]).toContain("Dano trusted authentication status: authenticated");
    expect(received[1]).not.toContain("Dano trusted authentication status: anonymous");
    broker.queueAssistantTurn("test-user", session.sessionId, undefined, "reauth_required");
    await session.prompt("Third request");
    expect(received[2]).toContain("Dano trusted authentication status: reauth_required");
    broker.queueAssistantTurn("test-user", session.sessionId, undefined);
    await session.prompt("Fourth request");
    expect(received[3]).toContain("Dano trusted authentication status: unknown");
    expect(received.join()).not.toMatch(/private-token|private-login-id/);
    expect(readCredential).not.toHaveBeenCalled();
    expect(JSON.stringify(session.messages)).not.toContain("Dano trusted authentication status:");
  } finally {
    result?.disposeDanoLlmResilience();
    await result?.runtime.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it.each(["anonymous", "authenticated"] as const)("projects trusted %s state without an OAuth credential broker", async authenticationStatus => {
  const root = await mkdtemp(join(tmpdir(), "dano-auth-no-oauth-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  const provider = fauxProvider({ provider: "authentication-without-oauth" });
  let received = "";
  provider.setResponses([context => {
    received = JSON.stringify(context.messages);
    return fauxAssistantMessage("done");
  }]);
  const models = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  models.registerNativeProvider(provider.provider);
  await models.setRuntimeApiKey(provider.provider.id, "test-only");
  let result: Awaited<ReturnType<typeof createDetachedAgentSessionRuntime>> | undefined;
  try {
    result = await createDetachedAgentSessionRuntime(root, SessionManager.inMemory(root), {
      modelRuntime: models, settingsManager: SettingsManager.inMemory(), model: provider.getModel(),
      thinkingLevel: "off", authenticationStatus,
    });
    await result.runtime.session.prompt("Business operation");
    expect(received).toContain(`Dano trusted authentication status: ${authenticationStatus}`);
  } finally {
    result?.disposeDanoLlmResilience();
    await result?.runtime.dispose();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
