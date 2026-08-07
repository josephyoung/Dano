<script lang="ts">
	import { Dialog as DialogPrimitive } from "bits-ui";
	import { cn } from "$lib/utils.js";

	export type DialogLayer = "dialog" | "lightbox";

	let {
		ref = $bindable(null),
		class: className,
		layer = "dialog",
		...restProps
	}: DialogPrimitive.OverlayProps & { layer?: DialogLayer } = $props();
</script>

<DialogPrimitive.Overlay
	bind:ref
	data-slot="dialog-overlay"
	data-layer={layer}
	class={cn("bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate", className)}
	{...restProps}
/>

<style>
	:global([data-slot="dialog-overlay"][data-layer="dialog"]) {
		z-index: var(--layer-dialog-overlay);
	}

	:global([data-slot="dialog-overlay"][data-layer="lightbox"]) {
		z-index: var(--layer-lightbox-overlay);
	}
</style>
