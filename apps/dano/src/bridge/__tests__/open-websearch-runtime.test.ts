import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { activateSkillSeed } from "../../../runtime/skill-seed.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("open-websearch runtime packaging", () => {
  it("activates the image-installed skill in Pi's global skill directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "dano-open-websearch-seed-"));
    tempDirs.push(root);
    const seedSkillsDir = join(root, "seed/.agents/skills");
    const agentDir = join(root, "agent");
    const agentSkillsDir = join(agentDir, "skills");
    const seedSkillDir = join(seedSkillsDir, "open-websearch");

    mkdirSync(join(seedSkillDir, "references"), { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(seedSkillDir, "SKILL.md"),
      "---\nname: open-websearch\n---\n",
    );
    writeFileSync(
      join(seedSkillDir, "references/tools.md"),
      "# Tools\n",
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify(
        {
          defaultModel: "operator-model",
          packages: ["npm:@example/operator-package@1.0.0"],
          skills: ["/operator/skills"],
        },
        null,
        2,
      )}\n`,
    );

    await activateSkillSeed({ seedSkillsDir, agentSkillsDir });
    await activateSkillSeed({ seedSkillsDir, agentSkillsDir });

    const installedPath = join(agentSkillsDir, "open-websearch");
    expect(lstatSync(installedPath).isDirectory()).toBe(true);
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toContain(
      "name: open-websearch",
    );
    expect(
      readFileSync(join(installedPath, "references/tools.md"), "utf8"),
    ).toBe("# Tools\n");
    expect(
      JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")),
    ).toEqual({
      defaultModel: "operator-model",
      packages: ["npm:@example/operator-package@1.0.0"],
      skills: ["/operator/skills"],
    });
  });

  it("preserves an operator-managed skill with the same name", async () => {
    const root = mkdtempSync(join(tmpdir(), "dano-open-websearch-existing-"));
    tempDirs.push(root);
    const seedSkillsDir = join(root, "seed/.agents/skills");
    const agentDir = join(root, "agent");
    const agentSkillsDir = join(agentDir, "skills");
    const seedSkillDir = join(seedSkillsDir, "open-websearch");
    const installedPath = join(agentSkillsDir, "open-websearch");

    mkdirSync(seedSkillDir, { recursive: true });
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(
      join(seedSkillDir, "SKILL.md"),
      "image skill\n",
    );
    writeFileSync(
      join(installedPath, "SKILL.md"),
      "operator skill\n",
    );

    await activateSkillSeed({ seedSkillsDir, agentSkillsDir });

    expect(lstatSync(installedPath).isDirectory()).toBe(true);
    expect(readFileSync(join(installedPath, "SKILL.md"), "utf8")).toBe(
      "operator skill\n",
    );
  });

  it("is discovered by Pi as a global skill without settings.skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "dano-open-websearch-git-root-"));
    tempDirs.push(root);
    const seedSkillsDir = join(root, "seed/.agents/skills");
    const runtimeDir = join(root, "runtime-data");
    const agentDir = join(runtimeDir, ".pi/agent");
    const agentSkillsDir = join(agentDir, "skills");
    const installedSkillDir = join(agentSkillsDir, "open-websearch");
    const workspaceDir = join(runtimeDir, "workspaces/repository");

    mkdirSync(join(seedSkillsDir, "open-websearch"), { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(seedSkillsDir, "open-websearch/SKILL.md"),
      "---\nname: open-websearch\ndescription: runtime search\n---\n",
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      `${JSON.stringify({ defaultProjectTrust: "always" })}\n`,
    );

    mkdirSync(join(workspaceDir, ".git"));
    await activateSkillSeed({ seedSkillsDir, agentSkillsDir });
    const loader = new DefaultResourceLoader({
      cwd: workspaceDir,
      agentDir,
    });
    await loader.reload();
    expect(
      loader
        .getSkills()
        .skills.some(
          skill => skill.filePath === join(installedSkillDir, "SKILL.md"),
        ),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")),
    ).toEqual({ defaultProjectTrust: "always" });
  });
});
