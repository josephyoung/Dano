<script lang="ts">
  import { DatePicker as DatePickerPrimitive } from "bits-ui";
  import { cn } from "$lib/utils.js";
  import Portal from "./date-picker-portal.svelte";

  let {
    ref = $bindable(null),
    class: className,
    children,
    ...restProps
  }: DatePickerPrimitive.ContentProps = $props();
</script>

<Portal>
  <DatePickerPrimitive.Content
    bind:ref
    data-slot="date-picker-content"
    class={cn("date-picker-content", className)}
    {...restProps}
  >
    {@render children?.()}
  </DatePickerPrimitive.Content>
</Portal>

<style>
  :global(.date-picker-content) {
    z-index: var(--layer-popover);
  }
</style>
