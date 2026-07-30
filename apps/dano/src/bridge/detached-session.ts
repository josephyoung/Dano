import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionResult,
  type SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { askUserQuestionTool } from "./ask-user-question.js";
import { createCurlTool } from "./curl-tool.js";
import { danoVersionTool } from "./dano-version-tool.js";
import { configureDanoLlmResilience } from "./llm-resilience.js";

function resolveHeimdallExtensionPath(): string {
  try {
    return createRequire(join(process.cwd(), "package.json")).resolve(
      "@josephyoung/pi-heimdall/extensions/heimdall.ts",
    );
  } catch {
    return fileURLToPath(
      import.meta.resolve("@josephyoung/pi-heimdall/extensions/heimdall.ts"),
    );
  }
}

const HEIMDALL_EXTENSION_PATH = resolveHeimdallExtensionPath();

export interface CreateDetachedAgentSessionOptions {
  model?: CreateAgentSessionFromServicesOptions["model"];
  thinkingLevel?: CreateAgentSessionFromServicesOptions["thinkingLevel"];
  askUserQuestionTool?: ToolDefinition;
}

export interface CreateDetachedAgentSessionResult
  extends CreateAgentSessionResult {
  disposeDanoLlmResilience(): void;
}

export async function createDetachedAgentSession(
  cwd: string,
  sessionManager: SessionManager,
  options: CreateDetachedAgentSessionOptions = {},
): Promise<CreateDetachedAgentSessionResult> {
  const services = await createAgentSessionServices({
    cwd,
    resourceLoaderOptions: {
      additionalExtensionPaths: [HEIMDALL_EXTENSION_PATH],
    },
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager,
    noTools: "builtin",
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    customTools: [
      createReadToolDefinition(cwd, {
        autoResizeImages: services.settingsManager.getImageAutoResize(),
      }),
      createCurlTool(cwd),
      createEditToolDefinition(cwd),
      createWriteToolDefinition(cwd),
      danoVersionTool,
      options.askUserQuestionTool ?? askUserQuestionTool,
    ] as unknown as ToolDefinition[],
  });
  const disposeDanoLlmResilience = configureDanoLlmResilience(
    services.settingsManager,
    result.session,
  );
  return { ...result, disposeDanoLlmResilience };
}
