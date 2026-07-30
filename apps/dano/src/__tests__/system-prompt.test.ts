import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  renderSystemPrompt,
  resolveProductName,
  writeSystemPromptFile,
} from "../../runtime/system-prompt.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })),
  );
});

describe("system prompt runtime", () => {
  it("uses the environment override before the configured product name", () => {
    expect(resolveProductName(" 环境助手 ", "配置助手")).toBe("环境助手");
    expect(resolveProductName("", " 配置助手 ")).toBe("配置助手");
    expect(() => resolveProductName("", "")).toThrow(
      "Set productName in dano.config.json or provide DANO_PRODUCT_NAME",
    );
  });

  it("renders every product-name placeholder", () => {
    expect(
      renderSystemPrompt("你是{产品名称}，请联系{产品名称}", "测试助手"),
    ).toBe("你是测试助手，请联系测试助手");
  });

  it("initializes without replacing an existing host-managed file", async () => {
    const root = await mkdtemp(join(tmpdir(), "dano-system-prompt-"));
    tempDirs.push(root);
    const targetPath = join(root, "SYSTEM.md");

    await expect(
      writeSystemPromptFile(targetPath, "首次内容", { mode: "if-missing" }),
    ).resolves.toBe("written");
    writeFileSync(targetPath, "宿主机内容");
    await expect(
      writeSystemPromptFile(targetPath, "第二次内容", { mode: "if-missing" }),
    ).resolves.toBe("preserved");

    expect(await readFile(targetPath, "utf8")).toBe("宿主机内容");
  });

  it("publishes exactly one complete file when initializers race", async () => {
    const root = await mkdtemp(join(tmpdir(), "dano-system-prompt-"));
    tempDirs.push(root);
    const targetPath = join(root, "SYSTEM.md");
    const candidates = Array.from(
      { length: 12 },
      (_, index) => `并发内容-${index}-结束`,
    );

    const results = await Promise.all(
      candidates.map(content =>
        writeSystemPromptFile(targetPath, content, { mode: "if-missing" }),
      ),
    );
    const finalContent = await readFile(targetPath, "utf8");

    expect(results.filter(result => result === "written")).toHaveLength(1);
    expect(results.filter(result => result === "preserved")).toHaveLength(11);
    expect(candidates).toContain(finalContent);
    expect(finalContent).toMatch(/^并发内容-\d+-结束$/);
  });

  it("atomically replaces a system prompt during an explicit deployment sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "dano-system-prompt-"));
    tempDirs.push(root);
    const targetPath = join(root, "SYSTEM.md");
    writeFileSync(targetPath, "旧名称");

    await expect(
      writeSystemPromptFile(targetPath, "新名称", { mode: "replace" }),
    ).resolves.toBe("written");

    expect(readFileSync(targetPath, "utf8")).toBe("新名称");
  });
});
