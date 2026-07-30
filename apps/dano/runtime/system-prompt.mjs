import { randomUUID } from "node:crypto";
import { link, readFile, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeFile as writeFileAtomic } from "atomically";

function isErrorCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

export function resolveProductName(environmentName, configuredName) {
  const productName = environmentName?.trim() || configuredName?.trim();
  if (!productName) {
    throw new Error(
      "Set productName in dano.config.json or provide DANO_PRODUCT_NAME",
    );
  }
  return productName;
}

export function renderSystemPrompt(template, productName) {
  return template.replaceAll("{产品名称}", productName);
}

async function initializeFile(targetPath, content) {
  const temporaryPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.dano-${randomUUID()}`,
  );

  // `atomically` completes and fsyncs the temporary file before publishing it.
  // A same-directory hard link then provides the no-clobber create primitive
  // that rename-based atomic writers intentionally do not offer.
  await writeFileAtomic(temporaryPath, content, {
    chown: false,
    mode: false,
  });

  try {
    await link(temporaryPath, targetPath);
    return "written";
  } catch (error) {
    if (isErrorCode(error, "EEXIST")) return "preserved";
    throw error;
  } finally {
    await unlink(temporaryPath).catch(error => {
      if (!isErrorCode(error, "ENOENT")) throw error;
    });
  }
}

export async function writeSystemPromptFile(targetPath, content, options) {
  if (options.mode === "if-missing") {
    return initializeFile(targetPath, content);
  }

  await writeFileAtomic(targetPath, content);
  return "written";
}

export async function syncSystemPrompt(options) {
  const template = await readFile(options.templatePath, "utf8");
  const content = renderSystemPrompt(template, options.productName);
  return writeSystemPromptFile(options.targetPath, content, {
    mode: options.mode,
  });
}
