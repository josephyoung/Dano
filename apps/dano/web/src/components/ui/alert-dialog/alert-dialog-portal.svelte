<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from "bits-ui";

	let { to = ".app-shell", ...restProps }: AlertDialogPrimitive.PortalProps = $props();
</script>

<AlertDialogPrimitive.Portal {to} {...restProps} />
