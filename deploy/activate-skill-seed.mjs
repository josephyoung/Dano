import { activateSkillSeed } from "../apps/dano/runtime/skill-seed.mjs";

export { activateSkillSeed };

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [seedSkillsDir, agentSkillsDir] = process.argv.slice(2);
  if (!seedSkillsDir || !agentSkillsDir) {
    throw new Error(
      "usage: activate-skill-seed.mjs <seed-skills-dir> <agent-skills-dir>",
    );
  }
  await activateSkillSeed({ seedSkillsDir, agentSkillsDir });
}
