<script lang="ts">
	import { Tooltip as TooltipPrimitive } from "bits-ui";

	let { to = ".app-shell", ...restProps }: TooltipPrimitive.PortalProps = $props();
</script>

<TooltipPrimitive.Portal {to} {...restProps} />
