import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/translate";

const uiDirectory = fileURLToPath(new URL("./", import.meta.url));
const componentsDirectory = fileURLToPath(new URL("../", import.meta.url));
const layoutDirectory = fileURLToPath(new URL("../../layout/", import.meta.url));
const danoDirectory = fileURLToPath(new URL("../../../../", import.meta.url));

function listSvelteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSvelteFiles(path);
    return extname(entry.name) === ".svelte" ? [path] : [];
  });
}

describe("shadcn-svelte component boundary", () => {
  it("keeps Bits UI imports inside the public component layer", () => {
    const featureFiles = [
      ...listSvelteFiles(componentsDirectory).filter(path => !path.startsWith(uiDirectory)),
      ...listSvelteFiles(layoutDirectory),
    ];

    for (const path of featureFiles) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/from ["']bits-ui["']/);
    }
  });

  it("keeps the official CLI aliases and Tailwind entrypoint executable", () => {
    const config = JSON.parse(readFileSync(join(danoDirectory, "components.json"), "utf8"));
    const css = readFileSync(join(danoDirectory, "web/src/app.css"), "utf8");

    expect(config.tailwind.css).toBe("web/src/app.css");
    expect(config.typescript.config).toBe("tsconfig.web.json");
    expect(config.aliases.ui).toBe("$lib/components/ui");
    expect(css).toContain('@import "tailwindcss"');
    expect(css).toContain("@theme inline");
  });

  it("targets shared floating layers at the themed application shell", () => {
    const portalFiles = [
      "dialog/dialog-portal.svelte",
      "alert-dialog/alert-dialog-portal.svelte",
      "sheet/sheet-portal.svelte",
      "popover/popover-portal.svelte",
      "tooltip/tooltip-portal.svelte",
      "select/select-portal.svelte",
      "date-picker/date-picker-portal.svelte",
    ];

    for (const relativePath of portalFiles) {
      const source = readFileSync(join(uiDirectory, relativePath), "utf8");
      expect(source, relativePath).toContain('to = ".app-shell"');
    }
  });

  it("localizes the public close controls", () => {
    const closeControlFiles = [
      "dialog/dialog-content.svelte",
      "dialog/dialog-footer.svelte",
      "sheet/sheet-content.svelte",
    ];

    for (const relativePath of closeControlFiles) {
      const source = readFileSync(join(uiDirectory, relativePath), "utf8");
      expect(source, relativePath).toContain('t("common.close")');
      expect(source, relativePath).not.toMatch(/>Close</);
    }

    expect(translate("common.close", { locale: "zh-CN" })).toBe("关闭");
    expect(translate("common.close", { locale: "en-US" })).toBe("Close");
  });
});
