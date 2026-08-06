<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";

	let { to = ".app-shell", ...restProps }: SelectPrimitive.PortalProps = $props();
</script>

<SelectPrimitive.Portal {to} {...restProps} />
