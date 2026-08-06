import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function activateSkillSeed({
  seedSkillsDir,
  agentSkillsDir,
}) {
  if (!pathExists(seedSkillsDir)) return;

  const seededSkills = readdirSync(seedSkillsDir, { withFileTypes: true }).filter(
    entry => entry.isDirectory(),
  );
  if (seededSkills.length === 0) return;

  mkdirSync(agentSkillsDir, { recursive: true });
  for (const skill of seededSkills) {
    const targetPath = join(agentSkillsDir, skill.name);
    if (pathExists(targetPath)) continue;

    const stagingDir = mkdtempSync(join(agentSkillsDir, ".dano-skill-seed-"));
    const stagedPath = join(stagingDir, skill.name);
    try {
      cpSync(join(seedSkillsDir, skill.name), stagedPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      if (!pathExists(targetPath)) renameSync(stagedPath, targetPath);
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
    }
  }
}
