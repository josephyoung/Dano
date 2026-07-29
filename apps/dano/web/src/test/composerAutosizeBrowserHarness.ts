import { createClassComponent } from "svelte/legacy";
import ComposerBar from "../components/ComposerBar.svelte";
import { ACCENT_COLOR_PRESETS, resolveAppThemeVars } from "../themes";
import { PI_BASE46_LIGHT_THEME } from "../themes/light";

for (const [name, value] of Object.entries(
  resolveAppThemeVars(PI_BASE46_LIGHT_THEME, ACCENT_COLOR_PRESETS.default),
)) {
  document.documentElement.style.setProperty(name, value);
}

document.body.style.margin = "0";
document.body.style.background = "var(--bg)";
document.body.style.color = "var(--text)";
document.body.style.fontFamily = "system-ui, sans-serif";

const app = document.getElementById("app")!;
app.style.width = "100%";

const component = createClassComponent({
  component: ComposerBar,
  target: app,
  props: {
    connectionStatus: "connected",
    slashCommandsAndMentionsEnabled: true,
    commands: [
      {
        name: "review",
        description: "Review the current changes",
        source: "prompt",
      },
    ],
    workspaceEntries: [
      {
        path: "docs/architecture/composer-autosize-browser-regression-notes.md",
        kind: "file",
      },
    ],
    workspaceContextKey: "composer-autosize-browser-test",
  },
});

const revisionText = [
  "请先检查当前工作区中的实现，确认现有行为与预期是否一致，然后只修改必要部分。",
  "需要覆盖普通输入、删除、粘贴、命令选择、工作区提及和历史消息回填，",
  "同时确保显式换行与随宽度变化产生的软换行都不会裁掉最后一行。",
].join("");

const trigger = document.createElement("button");
trigger.type = "button";
trigger.dataset.testid = "backfill-revision";
trigger.textContent = "回填历史消息";
trigger.hidden = true;
trigger.addEventListener("click", () => {
  component.$set({
    revision: {
      entryId: "composer-autosize-browser-test",
      text: revisionText,
      images: [],
    },
  });
});
document.body.append(trigger);
