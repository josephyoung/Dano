<script lang="ts">
	import { Dialog as SheetPrimitive } from "bits-ui";

	let { to = ".app-shell", ...restProps }: SheetPrimitive.PortalProps = $props();
</script>

<SheetPrimitive.Portal {to} {...restProps} />
