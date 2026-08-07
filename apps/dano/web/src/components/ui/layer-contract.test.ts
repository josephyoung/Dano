/** @vitest-environment happy-dom */

import { mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import LayerContractHarness from "./layer-contract.test-harness.svelte";

describe("shared floating-layer ownership", () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.body.style.removeProperty("overflow");
  });

  it.each(["dialog", "lightbox"] as const)(
    "keeps floating descendants above their %s owner",
    async layer => {
      const shell = document.createElement("div");
      shell.className = "app-shell";
      document.body.append(shell);
      const component = mount(LayerContractHarness, {
        target: shell,
        props: { layer },
      });
      await tick();

      try {
        expect(shell.querySelector("[data-slot=dialog-overlay]")?.getAttribute("data-dano-layer"))
          .toBe(`${layer}-overlay`);
        expect(shell.querySelector("[data-slot=dialog-content]")?.getAttribute("data-dano-layer"))
          .toBe(layer);
        expect(shell.querySelector("[data-slot=popover-content]")?.getAttribute("data-dano-layer"))
          .toBe(`${layer}-popover`);
        expect(shell.querySelector("[data-slot=tooltip-content]")?.getAttribute("data-dano-layer"))
          .toBe(`${layer}-tooltip`);
      } finally {
        await unmount(component);
      }
    },
  );
});
