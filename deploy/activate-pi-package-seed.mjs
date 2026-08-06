import { activatePiPackageSeed } from "../apps/dano/runtime/pi-package-seed.mjs";

export { activatePiPackageSeed };

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [seedDir, agentDir] = process.argv.slice(2);
  if (!seedDir || !agentDir) {
    throw new Error(
      "usage: activate-pi-package-seed.mjs <seed-agent-dir> <target-agent-dir>",
    );
  }
  await activatePiPackageSeed({ seedDir, agentDir });
}
