import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const switchScript = new URL(
  "../../../../../scripts/deploy-switch.mjs",
  import.meta.url,
).pathname;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("two-phase production Compose switch", () => {
  it.each(["switch", "rollback"] as const)(
    "updates only app then healthy-gated nginx for %s",
    action => {
      const { commands, output } = runSwitch(action);

      expect(commands).toEqual([
        [
          "compose",
          "-f",
          "docker-compose.yml",
          "-f",
          "docker-compose.exposure.yml",
          "--env-file",
          ".env",
          "up",
          "-d",
          "--no-build",
          "--no-deps",
          "app",
        ],
        [
          "compose",
          "-f",
          "docker-compose.yml",
          "-f",
          "docker-compose.exposure.yml",
          "--env-file",
          ".env",
          "ps",
          "-q",
          "app",
        ],
        ["inspect", "--format", "{{.State.Health.Status}}", "app-container-id"],
        [
          "compose",
          "-f",
          "docker-compose.yml",
          "-f",
          "docker-compose.exposure.yml",
          "--env-file",
          ".env",
          "up",
          "-d",
          "--no-build",
          "--no-deps",
          "nginx",
        ],
      ]);
      expect(output).not.toContain("secret-sentinel");
      expect(JSON.stringify(commands)).not.toMatch(
        /(?:down|volume|dano-site|skillmanner)/,
      );
    },
  );

  it("keeps nginx untouched when the replacement app is unhealthy", () => {
    expect(() => runSwitch("switch", "unhealthy")).toThrow();
    const commands = readCommands(temporaryRoots.at(-1)!);

    expect(commands.at(-1)).toEqual([
      "inspect",
      "--format",
      "{{.State.Health.Status}}",
      "app-container-id",
    ]);
    expect(commands.flat().filter(value => value === "nginx")).toEqual([]);
  });
});

function runSwitch(action: "switch" | "rollback", health = "healthy") {
  const root = mkdtempSync(join(tmpdir(), "dano-deploy-switch-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(root, "docker-compose.yml"),
    "services:\n  app:\n  nginx:\n",
  );
  writeFileSync(
    join(root, "docker-compose.exposure.yml"),
    "services:\n  nginx:\n",
  );
  writeFileSync(
    join(root, ".env"),
    "DANO_OAUTH_CLIENT_SECRET=secret-sentinel\n",
  );
  writeFileSync(
    join(bin, "compose"),
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.DANO_SWITCH_LOG, JSON.stringify(args) + "\\n");
if (args.includes("ps") && args.includes("-q")) process.stdout.write("app-container-id\\n");
if (args[0] === "inspect") process.stdout.write(process.env.DANO_FAKE_HEALTH + "\\n");
`,
  );
  chmodSync(join(bin, "compose"), 0o755);

  const output = execFileSync(process.execPath, [switchScript, action], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DANO_COMPOSE: join(bin, "compose"),
      DANO_SWITCH_LOG: join(root, "commands.log"),
      DANO_FAKE_HEALTH: health,
      DANO_DEPLOY_HEALTH_ATTEMPTS: "1",
      DANO_DEPLOY_HEALTH_INTERVAL_MS: "1",
    },
  });
  return { commands: readCommands(root), output };
}

function readCommands(root: string): string[][] {
  return readFileSync(join(root, "commands.log"), "utf8")
    .trim()
    .split("\n")
    .map(line => JSON.parse(line) as string[]);
}
