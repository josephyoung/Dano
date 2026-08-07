<script lang="ts">
	import { Dialog as SheetPrimitive } from "bits-ui";
	import { setLayerOwner } from "../layer-context.js";

	let { open = $bindable(false), ...restProps }: SheetPrimitive.RootProps = $props();

	setLayerOwner("dialog");
</script>

<SheetPrimitive.Root bind:open {...restProps} />
