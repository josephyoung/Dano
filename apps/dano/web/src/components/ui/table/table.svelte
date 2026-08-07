<script lang="ts">
	import { cn, type WithElementRef } from "$lib/utils.js";
	import type { HTMLTableAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		class: className,
		children,
		...restProps
	}: WithElementRef<HTMLTableAttributes> = $props();
</script>

<div data-slot="table-container" class="ui-table-scroll relative w-full overflow-x-auto">
	<table bind:this={ref} data-slot="table" class={cn("ui-table w-full caption-bottom text-sm", className)} {...restProps}>
		{@render children?.()}
	</table>
</div>

<style>
	.ui-table-scroll {
		max-width: 100%;
		margin: 0.6em 0;
		overflow-x: auto;
		border-radius: 8px;
		overscroll-behavior-inline: contain;
		scrollbar-width: thin;
	}

	.ui-table {
		width: 100%;
		border-collapse: separate;
		border-spacing: 0;
		color: var(--text);
		font-size: 0.85em;
		line-height: 1.5;
	}

	.ui-table :global(.ui-table-head),
	.ui-table :global(.ui-table-cell) {
		min-width: 8rem;
		padding: 10px 12px;
		border-right: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
		text-align: left;
		vertical-align: top;
		white-space: normal;
		overflow-wrap: anywhere;
	}

	.ui-table :global(.ui-table-head:first-child),
	.ui-table :global(.ui-table-cell:first-child) {
		border-left: 1px solid var(--border);
	}

	.ui-table :global(.ui-table-header .ui-table-head) {
		border-top: 1px solid var(--border);
		background: color-mix(in srgb, var(--accent) 10%, var(--panel));
		color: var(--text);
		font-weight: 600;
	}

	.ui-table :global(.ui-table-header:first-child .ui-table-row:first-child .ui-table-head:first-child) {
		border-top-left-radius: 8px;
	}

	.ui-table :global(.ui-table-header:first-child .ui-table-row:first-child .ui-table-head:last-child) {
		border-top-right-radius: 8px;
	}

	.ui-table :global(.ui-table-body:last-child .ui-table-row:last-child .ui-table-cell:first-child) {
		border-bottom-left-radius: 8px;
	}

	.ui-table :global(.ui-table-body:last-child .ui-table-row:last-child .ui-table-cell:last-child) {
		border-bottom-right-radius: 8px;
	}

	.ui-table :global(.ui-table-body .ui-table-row) {
		transition: background-color 120ms ease-out;
	}

	.ui-table :global(.ui-table-body .ui-table-row:hover) {
		background: color-mix(in srgb, var(--panel-2) 72%, transparent);
	}
</style>
