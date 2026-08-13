/** @vitest-environment happy-dom */

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ReauthenticationDialog from "./ReauthenticationDialog.svelte";

describe("ReauthenticationDialog", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("offers an explicit Anonymous fallback", async () => {
    const onCancel = vi.fn(async () => {
      throw new Error("temporary logout failure");
    });
    const onConfirm = vi.fn();
    const shell = document.createElement("div");
    shell.className = "app-shell";
    const target = document.createElement("div");
    shell.append(target);
    document.body.append(shell);
    const component = mount(ReauthenticationDialog, {
      target,
      props: { open: true, onCancel, onConfirm },
    });

    try {
      await tick();
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      expect(document.body.textContent).toContain("登录状态已失效");

      document
        .querySelector<HTMLButtonElement>(".reauth-cancel")!
        .click();
      await vi.waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
      await vi.waitFor(() =>
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(
          "请重试",
        ),
      );

    } finally {
      await unmount(component);
    }
  });

  it("offers explicit same-origin reauthentication", async () => {
    const onCancel = vi.fn(async () => {});
    const onConfirm = vi.fn();
    const shell = document.createElement("div");
    shell.className = "app-shell";
    const target = document.createElement("div");
    shell.append(target);
    document.body.append(shell);
    const component = mount(ReauthenticationDialog, {
      target,
      props: { open: true, onCancel, onConfirm },
    });

    try {
      await tick();
      document
        .querySelector<HTMLButtonElement>(".reauth-confirm")!
        .click();
      await tick();
      expect(onConfirm).toHaveBeenCalledOnce();
      expect(onCancel).not.toHaveBeenCalled();
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    } finally {
      await unmount(component);
    }
  });

  it("uses the standard shadcn AlertDialog content and footer structure", async () => {
    const shell = document.createElement("div");
    shell.className = "app-shell";
    const target = document.createElement("div");
    shell.append(target);
    document.body.append(shell);
    const component = mount(ReauthenticationDialog, {
      target,
      props: {
        open: true,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      },
    });

    try {
      await tick();
      const content = document.querySelector<HTMLElement>(
        '[data-slot="alert-dialog-content"]',
      );
      const footer = document.querySelector<HTMLElement>(
        '[data-slot="alert-dialog-footer"]',
      );
      const header = document.querySelector<HTMLElement>(
        '[data-slot="alert-dialog-header"]',
      );
      const cancel = document.querySelector<HTMLButtonElement>(
        ".reauth-cancel",
      );
      const confirm = document.querySelector<HTMLButtonElement>(
        ".reauth-confirm",
      );

      expect(content?.classList).toContain("sm:max-w-md");
      expect(content?.classList).toContain("overflow-hidden");
      expect(content?.classList).toContain("p-0");
      expect(header?.classList).toContain("p-6");
      expect(footer?.classList).toContain("border-t");
      expect(footer?.classList).toContain("bg-muted/30");
      expect(footer?.classList).toContain("p-4");
      expect(cancel?.classList).not.toContain("h-10");
      expect(confirm?.classList).not.toContain("h-10");
    } finally {
      await unmount(component);
    }
  });

  it("keeps Tailwind spacing utilities above the document reset", async () => {
    const indexHtml = await import("../../index.html?raw").then(
      (module) => module.default,
    );

    expect(indexHtml).not.toMatch(/\*[^{]*\{[^}]*padding:\s*0/s);
    expect(indexHtml).not.toMatch(/\*[^{]*\{[^}]*margin:\s*0/s);
  });

  it("keeps the required choice visible when Escape attempts to dismiss it", async () => {
    const shell = document.createElement("div");
    shell.className = "app-shell";
    const target = document.createElement("div");
    shell.append(target);
    document.body.append(shell);
    const component = mount(ReauthenticationDialog, {
      target,
      props: {
        open: true,
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      },
    });

    try {
      await tick();
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      await tick();
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    } finally {
      await unmount(component);
    }
  });
});
