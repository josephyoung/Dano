import { mount } from "svelte";
import CenterFocusScrollBrowserHarness from "./CenterFocusScrollBrowserHarness.svelte";
import { ACCENT_COLOR_PRESETS, resolveAppThemeVars } from "../themes";
import { PI_BASE46_LIGHT_THEME } from "../themes/light";

for (const [name, value] of Object.entries(
  resolveAppThemeVars(PI_BASE46_LIGHT_THEME, ACCENT_COLOR_PRESETS.default),
)) {
  document.documentElement.style.setProperty(name, value);
}

document.body.style.background = "var(--bg)";
document.body.style.color = "var(--text)";
document.body.style.fontFamily = "system-ui, sans-serif";

mount(CenterFocusScrollBrowserHarness, {
  target: document.getElementById("app")!,
});
