<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from "bits-ui";
	import { setLayerOwner } from "../layer-context.js";

	let { open = $bindable(false), ...restProps }: AlertDialogPrimitive.RootProps = $props();

	setLayerOwner("dialog");
</script>

<AlertDialogPrimitive.Root bind:open {...restProps} />
