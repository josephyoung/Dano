import {
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeFile as writeFileAtomic } from "atomically";

function packageSource(entry) {
  return typeof entry === "string" ? entry : entry?.source;
}

function parseGitSource(source) {
  if (typeof source !== "string" || !source.startsWith("git:")) {
    throw new Error(`unsupported seeded Pi package source: ${source}`);
  }

  const spec = source.slice("git:".length);
  const slashIndex = spec.indexOf("/");
  const refIndex = spec.lastIndexOf("@");
  const repoSpec = refIndex > slashIndex ? spec.slice(0, refIndex) : spec;
  const [host, ...pathParts] = repoSpec.split("/");
  if (!host || pathParts.length === 0 || pathParts.some((part) => !part)) {
    throw new Error(`unsupported seeded Pi git package source: ${source}`);
  }

  return {
    identity: `git:${host}/${pathParts.join("/")}`,
    relativePath: join("git", host, ...pathParts),
  };
}

function gitPackageIdentity(entry) {
  const source = packageSource(entry);
  return typeof source === "string" && source.startsWith("git:")
    ? parseGitSource(source).identity
    : undefined;
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function activatePiPackageSeed({ seedDir, agentDir }) {
  const seedSettingsPath = join(seedDir, "settings.json");
  if (!pathExists(seedSettingsPath)) return;

  const seedSettings = JSON.parse(readFileSync(seedSettingsPath, "utf8"));
  const seedPackages = Array.isArray(seedSettings.packages)
    ? seedSettings.packages
    : [];
  if (seedPackages.length === 0) return;

  mkdirSync(agentDir, { recursive: true });
  const targetSettingsPath = join(agentDir, "settings.json");
  const targetSettings = pathExists(targetSettingsPath)
    ? JSON.parse(readFileSync(targetSettingsPath, "utf8"))
    : {};
  const targetPackages = Array.isArray(targetSettings.packages)
    ? [...targetSettings.packages]
    : [];
  const targetIdentities = new Set(
    targetPackages.map(gitPackageIdentity).filter(Boolean),
  );
  let settingsChanged = false;

  for (const entry of seedPackages) {
    const source = packageSource(entry);
    const { identity, relativePath } = parseGitSource(source);
    const seedPackagePath = join(seedDir, relativePath);
    if (!pathExists(seedPackagePath)) {
      throw new Error(`missing seeded Pi package: ${seedPackagePath}`);
    }

    const targetPackagePath = join(agentDir, relativePath);
    if (!pathExists(targetPackagePath)) {
      mkdirSync(dirname(targetPackagePath), { recursive: true });
      symlinkSync(seedPackagePath, targetPackagePath, "dir");
    }

    if (!targetIdentities.has(identity)) {
      targetPackages.push(entry);
      targetIdentities.add(identity);
      settingsChanged = true;
    }
  }

  if (!settingsChanged) return;
  await writeFileAtomic(
    targetSettingsPath,
    `${JSON.stringify({ ...targetSettings, packages: targetPackages }, null, 2)}\n`,
  );
}
