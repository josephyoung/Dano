import { open, readFile } from "node:fs/promises";

const [templatePath, targetPath] = process.argv.slice(2);

if (!templatePath || !targetPath) {
  throw new Error("usage: render-system-prompt.mjs <template> <target>");
}

async function resolveProductName() {
  const environmentName = process.env.DANO_PRODUCT_NAME?.trim();
  if (environmentName) return environmentName;

  const configPath =
    process.env.DANO_CONFIG_PATH?.trim() || "/app/dano.config.json";
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const configuredName = config?.productName;
  if (typeof configuredName !== "string" || !configuredName.trim()) {
    throw new Error(`${configPath}: productName must be a non-empty string`);
  }
  return configuredName.trim();
}

const template = await readFile(templatePath, "utf8");
const productName = await resolveProductName();
let target;

try {
  target = await open(targetPath, "wx");
  await target.writeFile(template.replaceAll("{产品名称}", productName));
} catch (error) {
  if (error?.code !== "EEXIST") throw error;
} finally {
  await target?.close();
}
