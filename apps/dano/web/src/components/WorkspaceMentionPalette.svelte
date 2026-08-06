<script lang="ts">
  import { t } from "../i18n";
  import type { WorkspaceMentionSuggestion } from "../utils/workspaceMentions";
  import * as Command from "./ui/command";

  let {
    items = [] as readonly WorkspaceMentionSuggestion[],
    loading = false,
    emptyText = t("workspaceMentionPalette.empty"),
    onSelect = (_: WorkspaceMentionSuggestion) => {},
    onClose = () => {},
  }: {
    items: readonly WorkspaceMentionSuggestion[];
    loading: boolean;
    emptyText?: string;
    onSelect?: (item: WorkspaceMentionSuggestion) => void;
    onClose?: () => void;
  } = $props();

  let highlightedIndex = $state(0);
  let listRef = $state<HTMLElement | null>(null);

  let hasItems = $derived(items.length > 0);

  $effect(() => {
    void items;
    highlightedIndex = 0;
  });

  function scrollToHighlighted() {
    queueMicrotask(() => {
      const el = listRef?.children[highlightedIndex] as
        | HTMLElement
        | undefined;
      el?.scrollIntoView({ block: "nearest" });
    });
  }

  export function handleKeydown(event: KeyboardEvent) {
    if (loading) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      return;
    }

    if (!hasItems) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        highlightedIndex = (highlightedIndex + 1) % items.length;
        scrollToHighlighted();
        break;
      case "ArrowUp":
        event.preventDefault();
        highlightedIndex =
          (highlightedIndex - 1 + items.length) % items.length;
        scrollToHighlighted();
        break;
      case "Enter":
      case "Tab":
        event.preventDefault();
        if (items[highlightedIndex]) onSelect(items[highlightedIndex]);
        break;
      case "Escape":
        event.preventDefault();
        onClose();
        break;
    }
  }
</script>

<Command.Root
  class="workspace-palette"
  shouldFilter={false}
  value={items[highlightedIndex]?.path ?? ""}
>
  {#if loading}
    <div class="workspace-palette-empty">
      <span class="workspace-empty-text">{t("workspaceMentionPalette.indexing")}</span>
    </div>
  {:else if hasItems}
    <Command.List bind:ref={listRef} class="workspace-list">
      {#each items as item, idx (`${item.kind}:${item.path}`)}
        <Command.Item
          class={`workspace-item${idx === highlightedIndex ? " highlighted" : ""}`}
          value={`${item.kind}:${item.path}`}
          showIndicator={false}
          onSelect={() => onSelect(item)}
          onpointermove={() => (highlightedIndex = idx)}
        >
          <button
            class="workspace-item-btn"
            type="button"
            onclick={(event) => {
              event.stopPropagation();
              onSelect(item);
            }}
          >
            <div class="workspace-copy">
              <span class="workspace-name">{item.label}</span>
              <span class="workspace-path">{item.description}</span>
            </div>
          </button>
        </Command.Item>
      {/each}
    </Command.List>
  {:else}
    <div class="workspace-palette-empty">
      <span class="workspace-empty-text">{emptyText}</span>
    </div>
  {/if}
</Command.Root>

<style>
  :global(.workspace-palette) {
    position: absolute;
    left: 0;
    right: 0;
    bottom: calc(100% + 8px);
    max-height: 320px;
    overflow-y: auto;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    z-index: 10;
    scrollbar-width: none;
  }

  :global(.workspace-palette::-webkit-scrollbar) {
    display: none;
  }

  :global(.workspace-list) {
    list-style: none;
    margin: 0;
    padding: 6px;
  }

  :global(.workspace-item) {
    display: flex;
    align-items: center;
    min-height: 42px;
    padding: 0;
    border-radius: 10px;
    transition: background 0.1s ease;
  }

  .workspace-item-btn {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 42px;
    padding: 8px 12px;
    border: none;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
  }

  :global(.workspace-item:hover),
  :global(.workspace-item.highlighted) {
    background: var(--panel-2);
  }

  .workspace-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .workspace-name,
  .workspace-path {
    font-family: var(--pi-font-mono);
  }

  .workspace-empty-text {
    font-family: var(--pi-font-sans);
  }

  .workspace-name {
    font-size: 0.74rem;
    color: var(--text);
    white-space: nowrap;
  }

  .workspace-path {
    font-size: 0.68rem;
    color: var(--text-subtle);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-palette-empty {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
  }

  .workspace-empty-text {
    font-size: 0.72rem;
    color: var(--text-subtle);
  }
</style>
