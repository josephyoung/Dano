/** @vitest-environment happy-dom */

import { mount, tick, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";
import CommandPalette from "./CommandPalette.svelte";
import WorkspaceMentionPalette from "./WorkspaceMentionPalette.svelte";

describe("command palettes", () => {
  it("uses each Command option as the single slash-command interaction target", async () => {
    const target = document.createElement("div");
    const onSelect = vi.fn();
    const component = mount(CommandPalette, {
      target,
      props: {
        commands: [{ name: "compact", description: "Compact context" }],
        filter: "",
        onSelect,
      },
    });
    await tick();

    try {
      const option = target.querySelector<HTMLElement>('[role="option"]');
      expect(option).not.toBeNull();
      expect(option?.querySelector("button")).toBeNull();
      option?.click();
      expect(onSelect).toHaveBeenCalledOnce();
      expect(onSelect).toHaveBeenCalledWith("compact");
    } finally {
      await unmount(component);
    }
  });

  it("uses each Command option as the single workspace interaction target", async () => {
    const target = document.createElement("div");
    const onSelect = vi.fn();
    const item = {
      value: "@docs/guide.md",
      label: "guide.md",
      description: "docs/guide.md",
      kind: "file" as const,
      path: "docs/guide.md",
    };
    const component = mount(WorkspaceMentionPalette, {
      target,
      props: { items: [item], loading: false, onSelect },
    });
    await tick();

    try {
      const option = target.querySelector<HTMLElement>('[role="option"]');
      expect(option).not.toBeNull();
      expect(option?.querySelector("button")).toBeNull();
      option?.click();
      expect(onSelect).toHaveBeenCalledOnce();
      expect(onSelect).toHaveBeenCalledWith(item);
    } finally {
      await unmount(component);
    }
  });
});
