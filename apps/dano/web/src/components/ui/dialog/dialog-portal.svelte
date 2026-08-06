<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";

	let { to = ".app-shell", ...restProps }: DialogPrimitive.PortalProps = $props();
</script>

<DialogPrimitive.Portal {to} {...restProps} />
