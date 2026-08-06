import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activatePiPackageSeed } from "../../../runtime/pi-package-seed.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("open-websearch runtime packaging", () => {
  it("activates the image-installed Pi package without replacing operator settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "dano-open-websearch-seed-"));
    tempDirs.push(root);
    const seedDir = join(root, "seed");
    const agentDir = join(root, "agent");
    const packageSource =
      "git:github.com/Aas-ee/open-webSearch@v2.1.11";
    const seedPackageDir = join(
      seedDir,
      "git/github.com/Aas-ee/open-webSearch",
    );

    mkdirSync(join(seedPackageDir, "skills/open-websearch"), {
      recursive: true,
    });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(seedDir, "settings.json"),
      `${JSON.stringify({ packages: [packageSource] }, null, 2)}\n`,
    );
    writeFileSync(
      join(seedPackageDir, "skills/open-websearch/SKILL.md"),
      "---\nname: open-websearch\n---\n",
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          defaultModel: "operator-model",
          packages: ["npm:@example/operator-package@1.0.0"],
        },
        null,
        2,
      )}\n`,
    );

    await activatePiPackageSeed({ seedDir, agentDir });
    await activatePiPackageSeed({ seedDir, agentDir });

    const installedPath = join(
      agentDir,
      "git/github.com/Aas-ee/open-webSearch",
    );
    expect(lstatSync(installedPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(installedPath)).toBe(seedPackageDir);
    expect(
      JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")),
    ).toEqual({
      defaultModel: "operator-model",
      packages: ["npm:@example/operator-package@1.0.0", packageSource],
    });
  });

  it("preserves an operator-managed package with the same identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "dano-open-websearch-existing-"));
    tempDirs.push(root);
    const seedDir = join(root, "seed");
    const agentDir = join(root, "agent");
    const installedPath = join(
      agentDir,
      "git/github.com/Aas-ee/open-webSearch",
    );

    mkdirSync(
      join(seedDir, "git/github.com/Aas-ee/open-webSearch"),
      { recursive: true },
    );
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(
      join(seedDir, "settings.json"),
      `${JSON.stringify({ packages: ["git:github.com/Aas-ee/open-webSearch@v2.1.11"] })}\n`,
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ packages: ["git:github.com/Aas-ee/open-webSearch@v2.1.10"] })}\n`,
    );

    await activatePiPackageSeed({ seedDir, agentDir });

    expect(lstatSync(installedPath).isDirectory()).toBe(true);
    expect(
      JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))
        .packages,
    ).toEqual(["git:github.com/Aas-ee/open-webSearch@v2.1.10"]);
  });
});
