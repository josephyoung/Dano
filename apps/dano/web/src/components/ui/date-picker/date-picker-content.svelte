<script lang="ts">
  import { DatePicker as DatePickerPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";
  import { getFloatingLayer } from "../layer-context.js";
  import Portal from "./date-picker-portal.svelte";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: DatePickerPrimitive.ContentProps = $props();

  const layer = getFloatingLayer("popover");
</script>

<Portal>
  <DatePickerPrimitive.Content
    bind:ref
    data-slot="date-picker-content"
    class={cn("date-picker-content", className)}
    {...restProps}
    data-dano-layer={layer}
  >
    {@render children?.()}
  </DatePickerPrimitive.Content>
</Portal>
