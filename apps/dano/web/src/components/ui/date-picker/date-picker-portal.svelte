<script lang="ts">
  import { DatePicker as DatePickerPrimitive } from "bits-ui";

  let {
    to = ".app-shell",
    ...restProps
  }: DatePickerPrimitive.PortalProps = $props();
</script>

<DatePickerPrimitive.Portal {to} {...restProps} />
