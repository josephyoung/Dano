import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type {
  Api,
  AuthContext,
  CredentialStore,
  Model,
  Models,
  Provider,
} from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionRuntime,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  SettingsManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const PI_BASELINE_VERSION = "0.82.1";

type PiAiPublicContracts = {
  authContext: AuthContext;
  credentialStore: CredentialStore;
  model: Model<Api>;
  models: Pick<
    Models,
    "stream" | "complete" | "streamSimple" | "completeSimple"
  >;
  provider: Provider;
};

type PiCodingAgentPublicContracts = {
  agentSession: Pick<
    AgentSession,
    "model" | "thinkingLevel" | "pendingMessageCount"
  >;
  extensionRuntime: ExtensionRuntime;
  rpcCommand: RpcCommand;
  rpcExtensionUIRequest: RpcExtensionUIRequest;
  rpcExtensionUIResponse: RpcExtensionUIResponse;
  settingsManager: Pick<
    SettingsManager,
    "getDefaultProvider" | "getDefaultModel" | "getDefaultThinkingLevel"
  >;
  toolDefinition: ToolDefinition;
};

function acceptPublicContracts(
  _piAi: PiAiPublicContracts,
  _piCodingAgent: PiCodingAgentPublicContracts,
): void {}

describe("Pi 0.82.1 public interface baseline", () => {
  it("pins both Pi packages to the verified release", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies).toMatchObject({
      "@earendil-works/pi-ai": PI_BASELINE_VERSION,
      "@earendil-works/pi-coding-agent": PI_BASELINE_VERSION,
    });
    expect(piCodingAgent.VERSION).toBe(PI_BASELINE_VERSION);
  });

  it("exposes the later migration capabilities from package roots", () => {
    expect(acceptPublicContracts).toEqual(expect.any(Function));
    expect(piCodingAgent).toMatchObject({
      AgentSession: expect.any(Function),
      AgentSessionRuntime: expect.any(Function),
      ModelRuntime: expect.any(Function),
      SessionManager: expect.any(Function),
      SettingsManager: expect.any(Function),
      createAgentSession: expect.any(Function),
      createAgentSessionRuntime: expect.any(Function),
      createCodingTools: expect.any(Function),
      createExtensionRuntime: expect.any(Function),
      RpcClient: expect.any(Function),
      runRpcMode: expect.any(Function),
    });
    expect(piAi).toMatchObject({
      AssistantMessageEventStream: expect.any(Function),
      InMemoryCredentialStore: expect.any(Function),
      createModels: expect.any(Function),
      createProvider: expect.any(Function),
      defaultProviderAuthContext: expect.any(Function),
      lazyStream: expect.any(Function),
      retryAssistantCall: expect.any(Function),
    });
  });

  it("keeps Pi-owned session defaults and pending state out of Dano mirrors", () => {
    const bridgeDirectory = new URL("..", import.meta.url);
    const bridgeSources = readdirSync(bridgeDirectory)
      .filter(name => name.endsWith(".ts"))
      .map(name => ({
        name,
        source: readFileSync(new URL(name, bridgeDirectory), "utf8"),
      }));
    const allBridgeSources = bridgeSources.map(({ source }) => source).join("\n");
    const danoConfigSource = readFileSync(
      new URL("../dano-config.ts", import.meta.url),
      "utf8",
    );
    const backendSource = readFileSync(
      new URL("../../backend.ts", import.meta.url),
      "utf8",
    );
    const storedSessionStateSource = readFileSync(
      new URL("../stored-session-state.ts", import.meta.url),
      "utf8",
    );
    const productConfig = readFileSync(
      new URL("../../../../../dano.config.json", import.meta.url),
      "utf8",
    );

    for (const source of [danoConfigSource, productConfig]) {
      expect(source).not.toMatch(
        /\bdefaultProvider\b|\bdefaultModel\b|\bdefaultThinkingLevel\b|\bdefaultProjectTrust\b/,
      );
    }
    expect(existsSync(new URL("../default-model.ts", import.meta.url))).toBe(
      false,
    );
    expect(allBridgeSources).not.toMatch(
      /DEFAULT_MODEL_PER_PROVIDER|appendModelChange|appendThinkingLevelChange|session\.state/,
    );
    expect(allBridgeSources).not.toMatch(
      /resolveAgentSessionDefaults|initializeSessionManagerDefaults/,
    );
    expect(storedSessionStateSource).not.toMatch(/pendingMessageCount|queue_update/);

    // Queue item editing/cancellation and in-process RPC projection are the
    // explicit #386 deferred exception; no other bridge module may mirror it.
    for (const { name, source } of bridgeSources) {
      if (name === "bridge-rpc-adapter.ts") continue;
      expect(source).not.toMatch(
        /_steeringMessages|_followUpMessages|steeringQueue|followUpQueue|queue_update/,
      );
    }
    expect(backendSource).toContain("session.pendingMessageCount");
    expect(backendSource).not.toContain('event.type === "queue_update"');
  });

  it("keeps Field Assist on the public ModelRuntime boundary", () => {
    const fieldAssistSource = readFileSync(
      new URL("../field-assist.ts", import.meta.url),
      "utf8",
    );

    expect(fieldAssistSource).toContain("modelRuntime.complete");
    expect(fieldAssistSource).not.toMatch(
      /\bcreateAgentSession\b|\bSessionManager\b|\bSettingsManager\b/,
    );
  });
});
