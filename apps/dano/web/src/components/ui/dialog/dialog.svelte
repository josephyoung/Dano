<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { untrack } from "svelte";
	import { setLayerOwner, type ModalLayer } from "../layer-context.js";

	let {
		open = $bindable(false),
		layer = "dialog",
		...restProps
	}: DialogPrimitive.RootProps & { layer?: ModalLayer } = $props();

	setLayerOwner(untrack(() => layer));
</script>

<DialogPrimitive.Root bind:open {...restProps} />
