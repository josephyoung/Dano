<script lang="ts">
	import * as Dialog from "./dialog";
	import * as Popover from "./popover";
	import * as Tooltip from "./tooltip";

	let { layer = "dialog" }: { layer?: "dialog" | "lightbox" } = $props();
</script>

<Dialog.Root open {layer}>
	<Dialog.Content aria-label="Layer owner" showCloseButton={false}>
		<Dialog.Title>Layer owner</Dialog.Title>
		<Popover.Root open>
			<Popover.Trigger>Popover trigger</Popover.Trigger>
			<Popover.Content>Popover content</Popover.Content>
		</Popover.Root>
		<Tooltip.Provider>
			<Tooltip.Root open>
				<Tooltip.Trigger>Tooltip trigger</Tooltip.Trigger>
				<Tooltip.Content>Tooltip content</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
	</Dialog.Content>
</Dialog.Root>
