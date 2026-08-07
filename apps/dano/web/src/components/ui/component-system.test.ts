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

  it("defines one ordered layer contract and applies it in shared wrappers", () => {
    const css = readFileSync(join(danoDirectory, "web/src/app.css"), "utf8");
    const layerNames = [
      "popover",
      "dialog-overlay",
      "dialog",
      "tooltip",
      "lightbox-overlay",
      "lightbox",
      "notification",
    ];
    const layers = layerNames.map(name => {
      const match = css.match(new RegExp(`--layer-${name}:\\s*(\\d+)`));
      expect(match, name).not.toBeNull();
      return Number(match?.[1]);
    });

    expect(layers).toEqual([...layers].sort((a, b) => a - b));
    expect(new Set(layers).size).toBe(layers.length);

    const wrapperLayers = new Map([
      ["dialog/dialog-overlay.svelte", "--layer-dialog-overlay"],
      ["dialog/dialog-content.svelte", "--layer-dialog"],
      ["alert-dialog/alert-dialog-overlay.svelte", "--layer-dialog-overlay"],
      ["alert-dialog/alert-dialog-content.svelte", "--layer-dialog"],
      ["sheet/sheet-overlay.svelte", "--layer-dialog-overlay"],
      ["sheet/sheet-content.svelte", "--layer-dialog"],
      ["popover/popover-content.svelte", "--layer-popover"],
      ["select/select-content.svelte", "--layer-popover"],
      ["date-picker/date-picker-content.svelte", "--layer-popover"],
      ["tooltip/tooltip-content.svelte", "--layer-tooltip"],
      ["sonner/sonner.svelte", "--layer-notification"],
    ]);

    for (const [relativePath, layer] of wrapperLayers) {
      const source = readFileSync(join(uiDirectory, relativePath), "utf8");
      expect(source, relativePath).toContain(layer);
      expect(source, relativePath).not.toMatch(/(?:^|\s)z-(?:50|\[)/);
    }

    const featureLayerSelectors = new Map([
      ["ThemeSettingsDialog.svelte", /theme-dialog(?:-overlay)?/],
      ["ExtensionDialog.svelte", /dialog-overlay/],
      ["ImageLightbox.svelte", /image-lightbox-(?:shell|backdrop)/],
      ["QuestionRemoteCombobox.svelte", /question-combobox-popover/],
    ]);

    for (const [relativePath, selector] of featureLayerSelectors) {
      const source = readFileSync(join(componentsDirectory, relativePath), "utf8");
      expect(source, relativePath).not.toMatch(
        new RegExp(`:global\\(\\.${selector.source}\\)\\s*\\{[^}]*z-index`, "s"),
      );
    }

    expect(readFileSync(join(layoutDirectory, "AppHeader.svelte"), "utf8")).not.toMatch(
      /:global\(\.header-menu\)\s*\{[^}]*z-index/s,
    );
    expect(readFileSync(join(layoutDirectory, "AppNotifications.svelte"), "utf8")).not.toContain(
      "--layer-notification",
    );
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
