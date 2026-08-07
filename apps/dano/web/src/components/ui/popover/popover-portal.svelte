<script lang="ts">
	import { Popover as PopoverPrimitive } from "bits-ui";

	let { to = ".app-shell", ...restProps }: PopoverPrimitive.PortalProps = $props();
</script>

<PopoverPrimitive.Portal {to} {...restProps} />
