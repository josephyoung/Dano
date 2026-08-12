import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UserContext } from "../user-context.js";
import { UserRuntimeRegistry } from "../user-runtime-registry.js";

const runtimeRoots: string[] = [];

afterEach(() => {
  for (const root of runtimeRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("UserRuntimeRegistry owner transfer", () => {
  it("merges preference objects while preserving unrelated file conflicts", async () => {
    const runtimeRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "dano-owner-transfer-"),
    );
    runtimeRoots.push(runtimeRoot);
    const source = userContext(runtimeRoot, "anonymous-source");
    const target = userContext(runtimeRoot, "authenticated-target");
    writeJson(path.join(source.folderPath, "preferences", "layout.json"), {
      sourceOnly: "migrated",
      shared: "anonymous",
    });
    writeJson(path.join(target.folderPath, "preferences", "layout.json"), {
      targetOnly: "retained",
      shared: "authenticated",
    });
    writeText(
      path.join(source.folderPath, "workspaces", "default", "shared.txt"),
      "anonymous content",
    );
    writeText(
      path.join(target.folderPath, "workspaces", "default", "shared.txt"),
      "authenticated content",
    );
    const registry = new UserRuntimeRegistry(async () => {
      throw new Error("test backend should not be created");
    });

    await registry.transferOwnership(source, target, {
      assertIdle() {},
      async commitOwnership() {},
    });

    expect(
      JSON.parse(
        fs.readFileSync(
          path.join(target.folderPath, "preferences", "layout.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      sourceOnly: "migrated",
      targetOnly: "retained",
      shared: "authenticated",
    });
    expect(
      fs.existsSync(
        path.join(target.folderPath, "preferences", "layout.anonymous-1.json"),
      ),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(target.folderPath, "workspaces", "default", "shared.txt"),
        "utf8",
      ),
    ).toBe("authenticated content");
    expect(
      fs.readFileSync(
        path.join(
          target.folderPath,
          "workspaces",
          "default",
          "shared.anonymous-1.txt",
        ),
        "utf8",
      ),
    ).toBe("anonymous content");
  });
});

function userContext(runtimeRoot: string, userId: string): UserContext {
  return {
    user: { id: userId },
    folderPath: path.join(runtimeRoot, "users", userId),
  };
}

function writeJson(filePath: string, value: Record<string, unknown>): void {
  writeText(filePath, `${JSON.stringify(value)}\n`);
}

function writeText(filePath: string, value: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, value, "utf8");
}
