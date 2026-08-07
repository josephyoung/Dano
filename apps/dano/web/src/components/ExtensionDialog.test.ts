/** @vitest-environment happy-dom */

import type { RpcExtensionUIRequest } from "@dano/types/protocol";
import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExtensionDialog from "./ExtensionDialog.svelte";

type DialogRequest = Extract<
  RpcExtensionUIRequest,
  { method: "select" | "confirm" | "input" | "editor" }
>;

function createAppTarget() {
  const target = document.createElement("div");
  target.className = "app-shell";
  document.body.append(target);
  return target;
}

describe("ExtensionDialog", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.body.style.removeProperty("overflow");
  });

  it("projects confirmations through the shared modal and button components", async () => {
    const target = createAppTarget();
    const onRespond = vi.fn();
    const request = {
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "Delete draft?",
      message: "This cannot be undone.",
    } as DialogRequest;
    const component = mount(ExtensionDialog, {
      target,
      props: { request, onRespond },
    });
    await tick();

    try {
      expect(target.querySelector("[data-slot=dialog-overlay]")).not.toBeNull();
      expect(target.querySelector("[data-slot=dialog-content]")?.getAttribute("role")).toBe(
        "dialog",
      );
      expect(target.querySelector("[data-slot=dialog-title]")?.textContent).toBe(
        "Delete draft?",
      );
      target.querySelectorAll<HTMLButtonElement>(".dialog-actions button")[1]!.click();
      expect(onRespond).toHaveBeenCalledWith({
        type: "extension_ui_response",
        id: "confirm-1",
        confirmed: true,
      });
    } finally {
      unmount(component);
    }
  });

  it("maps Escape to the existing cancelled response", async () => {
    const target = createAppTarget();
    const onRespond = vi.fn();
    const request = {
      type: "extension_ui_request",
      id: "input-1",
      method: "input",
      title: "Name",
      placeholder: "Draft name",
    } as DialogRequest;
    const component = mount(ExtensionDialog, {
      target,
      props: { request, onRespond },
    });
    await tick();

    try {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await tick();
      expect(onRespond).toHaveBeenCalledWith({
        type: "extension_ui_response",
        id: "input-1",
        cancelled: true,
      });
    } finally {
      unmount(component);
    }
  });
});
