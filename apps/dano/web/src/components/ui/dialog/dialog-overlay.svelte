<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";
	import type { ModalLayer } from "../layer-context.js";

	let {
		ref = $bindable(null),
		class: className,
		layer = "dialog",
		...restProps
	}: DialogPrimitive.OverlayProps & { layer?: ModalLayer } = $props();
</script>

<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	class={cn("bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate", className)}
	{...restProps}
	data-dano-layer={`${layer}-overlay`}
/>
