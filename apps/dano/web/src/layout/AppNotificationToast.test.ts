/** @vitest-environment happy-dom */

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppNotificationToast from "./AppNotificationToast.svelte";

describe("AppNotificationToast", () => {
  afterEach(() => document.body.replaceChildren());

  it("preserves alert semantics and delegates dismissal to the notification owner", async () => {
    const onDismiss = vi.fn();
    const closeToast = vi.fn();
    const component = mount(AppNotificationToast, {
      target: document.body,
      props: {
        message: "Connection lost",
        typeLabel: "Error",
        error: true,
        dismissible: true,
        onDismiss,
        closeToast,
      },
    });
    await tick();

    try {
      expect(document.querySelector("[role=alert]")?.textContent).toContain("Connection lost");
      document.querySelector<HTMLButtonElement>("button")!.click();
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(closeToast).toHaveBeenCalledOnce();
    } finally {
      unmount(component);
    }
  });
});
