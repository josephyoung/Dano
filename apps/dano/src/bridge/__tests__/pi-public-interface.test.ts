import { readFileSync } from "node:fs";
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
  agentSession: AgentSession;
  extensionRuntime: ExtensionRuntime;
  rpcCommand: RpcCommand;
  rpcExtensionUIRequest: RpcExtensionUIRequest;
  rpcExtensionUIResponse: RpcExtensionUIResponse;
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
});
