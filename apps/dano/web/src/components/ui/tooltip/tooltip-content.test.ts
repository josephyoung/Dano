import { describe, expect, it } from "vitest";
import tooltipContentSource from "./tooltip-content.svelte?raw";

describe("Tooltip content", () => {
  it("does not render an arrow", () => {
    expect(tooltipContentSource).not.toContain("TooltipPrimitive.Arrow");
  });
});
