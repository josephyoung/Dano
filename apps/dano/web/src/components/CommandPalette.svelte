<script lang="ts">
  import { t } from "../i18n";
  import type { SlashCommandOption } from "../utils/slashCommands";
  import * as Command from "./ui/command";

  let {
    commands = [] as SlashCommandOption[],
    filter = "",
    isDebugMode = false,
    onSelect = (_: string) => {},
    onClose = () => {},
  }: {
    commands: SlashCommandOption[];
    filter: string;
    isDebugMode?: boolean;
    onSelect?: (commandName: string) => void;
    onClose?: () => void;
  } = $props();

  let highlightedIndex = $state(0);
  let listRef = $state<HTMLElement | null>(null);
  const debugEmptyExamples = "`/fixture mixed`, `/fixture edit`, `/tps 12`";

  let filtered = $derived.by(() => {
    const q = filter.toLowerCase();
    if (!q) return commands;
    return commands.filter(
      c =>
        c.name.toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q),
    );
  });

  $effect(() => {
    void filter;
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

  export function handleKeydown(e: KeyboardEvent) {
    if (filtered.length === 0) {
      if (e.key === "Escape") onClose();
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        highlightedIndex = (highlightedIndex + 1) % filtered.length;
        scrollToHighlighted();
        break;
      case "ArrowUp":
        e.preventDefault();
        highlightedIndex =
          (highlightedIndex - 1 + filtered.length) % filtered.length;
        scrollToHighlighted();
        break;
      case "Enter":
        e.preventDefault();
        if (filtered[highlightedIndex]) {
          onSelect(filtered[highlightedIndex].name);
        }
        break;
      case "Escape":
        e.preventDefault();
        onClose();
        break;
    }
  }
</script>

{#if filtered.length > 0}
  <Command.Root
    class="command-palette"
    shouldFilter={false}
    value={filtered[highlightedIndex]?.name ?? ""}
  >
    {#if isDebugMode}
      <div class="command-hint">{t("commandPalette.debugHint")}</div>
    {/if}
    <Command.List bind:ref={listRef} class="command-list">
      {#each filtered as cmd, idx (cmd.name)}
        <Command.Item
          class={`command-item${idx === highlightedIndex ? " highlighted" : ""}`}
          value={cmd.name}
          showIndicator={false}
          onSelect={() => onSelect(cmd.name)}
          onpointermove={() => (highlightedIndex = idx)}
        >
          <div class="command-copy">
            <span class="cmd-name">/{cmd.name}</span>
            {#if cmd.description}
              <span class="cmd-desc">{cmd.description}</span>
            {/if}
          </div>
        </Command.Item>
      {/each}
    </Command.List>
  </Command.Root>
{:else}
  <Command.Root class="command-palette empty" shouldFilter={false}>
    <Command.Empty>
      <span class="empty-text">
        {isDebugMode
          ? t("commandPalette.emptyDebug")
          : t("commandPalette.empty")}
      </span>
      {#if isDebugMode}
        <span class="empty-hint">{t("commandPalette.debugEmptyHint", { examples: debugEmptyExamples })}</span>
      {/if}
    </Command.Empty>
  </Command.Root>
{/if}

<style>
  :global(.command-palette) {
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

  :global(.command-palette::-webkit-scrollbar) {
    display: none;
  }

  :global(.command-palette.empty) {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
  }

  .command-hint {
    padding: 10px 12px 0;
    font-size: 0.72rem;
    color: var(--text-subtle);
  }

  :global(.command-list) {
    list-style: none;
    margin: 0;
    padding: 6px;
  }

  :global(.command-item) {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 38px;
    padding: 8px 12px;
    border-radius: 10px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    text-align: left;
    transition: background 0.1s ease;
  }

  :global(.command-item:hover),
  :global(.command-item.highlighted) {
    background: var(--panel-2);
  }

  .command-copy {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .cmd-name {
    font-size: 0.78rem;
    color: var(--text);
    white-space: nowrap;
  }

  .cmd-desc {
    font-size: 0.72rem;
    color: var(--text-subtle);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty-text {
    font-size: 0.76rem;
    color: var(--text-subtle);
  }

  .empty-hint {
    margin-top: 4px;
    font-size: 0.72rem;
    color: var(--text-subtle);
  }
</style>
