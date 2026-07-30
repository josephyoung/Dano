import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function productionTypeScriptFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__"
        ? []
        : productionTypeScriptFiles(entryPath);
    }
    return entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [entryPath]
      : [];
  });
}

describe("provider retry ownership guard", () => {
  it("keeps provider retry count, backoff, and per-request timeout out of Dano", () => {
    const productRetryExceptions = new Set([
      "apps/dano/src/bridge/ask-user-question.ts",
      "apps/dano/src/bridge/dano-config.ts",
      "apps/dano/src/bridge/field-assist.ts",
    ]);
    const productionSources = productionTypeScriptFiles(
      path.join(repoRoot, "apps/dano/src"),
    )
      .map(file => path.relative(repoRoot, file))
      .filter(file => !productRetryExceptions.has(file));
    const retryOwnershipSource = productionSources
      .map(file => `// ${file}\n${readRepoFile(file)}`)
      .join("\n");
    const deploymentInputs = [
      readRepoFile(".env.example"),
      readRepoFile("docker-compose.yml"),
    ].join("\n");
    const runtimeSettings = JSON.parse(
      readRepoFile("deploy/runtime-defaults/settings.json"),
    ) as {
      retry?: { provider?: { timeoutMs?: number } };
    };

    expect(productionSources).toContain(
      "apps/dano/src/bridge/llm-resilience.ts",
    );
    expect(productionSources).toContain(
      "apps/dano/src/bridge/detached-session.ts",
    );
    expect(retryOwnershipSource).not.toMatch(
      /DANO_LLM_(?:MAX_RETRIES|RETRY_)|retryWouldStartAt|retryAttempt|providerRetry|retryProvider|(?:for|while)\s*\([^)]*retry/i,
    );
    expect(retryOwnershipSource).not.toMatch(
      /retry\s*:\s*\{[^}]*?(?:maxRetries|baseDelayMs|provider\s*:)/s,
    );
    expect(deploymentInputs).not.toContain("DANO_LLM_TIMEOUT_MS");
    expect(deploymentInputs).toContain("DANO_ASSISTANT_TURN_TIMEOUT_MS");
    expect(runtimeSettings.retry?.provider?.timeoutMs).toBe(300_000);
  });
});
